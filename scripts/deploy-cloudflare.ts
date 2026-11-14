import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { retiringTables, retirementArchivePlan, assertRetirementArchives, assertRetirementInventory } from '../src/platform/database/retirement.ts';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
export type DeployOptions = { config: string; dryRun: boolean; secretsFile?: string; archiveRetired?: boolean };

// Inputs bundled into the Worker or copied into dist. Tests, docs, migrations and
// other platform adapters do not change the uploaded artifact, so they stay out.
const buildInputs = ['src', 'packages/agent-runtime', 'deploy/cloudflare', 'public',
  'vite.config.ts', 'index.html', 'tsconfig.json', 'package.json', 'package-lock.json',
  'wrangler.jsonc', 'wrangler.production.jsonc'] as const;
const ignoredDirectories = new Set(['node_modules', 'dist', '.wrangler', 'test-results', '.git']);
const ignoredFile = /(^|\/)(\.DS_Store|[^/]+\.test\.[cm]?[jt]sx?)$/;

async function newestBuildInput(root: string, inputs: readonly string[]): Promise<{ path: string; mtimeMs: number } | null> {
  let newest: { path: string; mtimeMs: number } | null = null;
  const keep = (path: string, mtimeMs: number) => { if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs }; };
  const visit = async (path: string) => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
    for (const entry of entries ?? []) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) { if (!ignoredDirectories.has(entry.name)) await visit(child); continue; }
      if (!entry.isFile() || ignoredFile.test(entry.name)) continue;
      const info = await stat(child).catch(() => null);
      if (info) keep(child, info.mtimeMs);
    }
  };
  for (const input of inputs) {
    const path = resolve(root, input), info = await stat(path).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) await visit(path);
    else if (info.isFile() && !ignoredFile.test(input)) keep(path, info.mtimeMs);
  }
  return newest;
}

/** Refuses to upload a stale build: an edited source file is newer than the worker entry. */
export async function assertBuildFresh(options: { root: string; configPath: string; config: unknown }): Promise<void> {
  const config = options.config;
  if (!config || typeof config !== 'object' || !('main' in config)
    || typeof config.main !== 'string' || !config.main) return;
  const artifact = resolve(dirname(options.configPath), config.main);
  const built = await stat(artifact).catch(() => null);
  if (!built?.isFile()) throw new Error('The built worker entry is missing. Run npm run build before deploying. No remote command was run.');
  const newest = await newestBuildInput(options.root, buildInputs);
  if (!newest || newest.mtimeMs <= built.mtimeMs) return;
  const path = relative(options.root, newest.path) || newest.path;
  throw new Error(`Source ${path} is newer than the build. Run npm run build before deploying. No remote command was run.`);
}

export function deployArguments(options: DeployOptions, config: unknown): string[][] {
  if (!config || typeof config !== 'object' || !('name' in config)
    || typeof config.name !== 'string' || !config.name
    || !('main' in config) || typeof config.main !== 'string') {
    throw new Error('Build the application before deploying: npm run build');
  }
  const deployment = ['deploy', '--config', options.config];
  if (options.secretsFile) deployment.push('--secrets-file', options.secretsFile);
  if (options.dryRun) return [[...deployment, '--dry-run']];
  const databases = 'd1_databases' in config ? config.d1_databases : undefined;
  const binding = Array.isArray(databases) ? databases.find((value: unknown) =>
    !!value && typeof value === 'object' && 'binding' in value && value.binding === 'DB') as Record<string, unknown> | undefined : undefined;
  if (!binding || typeof binding.database_id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(binding.database_id)) {
    throw new Error('DB must reference a provisioned D1 database. Replace dingbell-local-only, then rebuild. No remote command was run.');
  }
  // Use the binding, so the deploy wizard can rename the user's database.
  // Pin both commands to the same built configuration, including its migration path.
  return [['d1', 'migrations', 'apply', 'DB', '--remote', '--config', options.config], deployment];
}

export function assertLegacyRunsDrained(rows: Record<string, unknown>[], expected: number): void {
  if (rows.length !== expected || rows.some(row =>
    typeof row.pending !== 'number' || !Number.isSafeInteger(row.pending) || row.pending < 0)) {
    throw new Error('Legacy execution drain could not be confirmed. No migration or upload was run.');
  }
  if (rows.some(row => Number(row.pending) > 0)) {
    throw new Error('Legacy executions remain unsettled. Pause admissions and reconcile them using the old deployment before upgrading. Original receipts and checkpoints must be retained. No migration or upload was run.');
  }
}

async function query(options: DeployOptions, sql:string):Promise<Record<string,unknown>[]>{
    if(options.dryRun)throw new Error('Dry runs cannot query or mutate a remote database.');
    const output=await new Promise<string>((done,reject)=>{
      const child=spawn(process.execPath,[resolve(root,'node_modules/wrangler/bin/wrangler.js'),'d1','execute','DB','--remote','--config',options.config,'--command',sql,'--json'],{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
      let text='';
      const timer=setTimeout(()=>child.kill('SIGKILL'),90000);
      child.stdout.on('data',chunk=>{text+=chunk;if(Buffer.byteLength(text)>1024*1024)child.kill('SIGKILL');});
      child.stderr.resume();
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',code=>{clearTimeout(timer);code===0?done(text):reject(new Error('Legacy execution drain could not be confirmed; no migration or upload was run.'));});
    });
    const result=JSON.parse(output) as {success?:boolean;results?:Record<string,unknown>[]}[];
    if(!Array.isArray(result)||!result.length||result.some(value=>value.success!==true||!Array.isArray(value.results)))throw new Error('Legacy execution drain could not be confirmed.');
    return result.flatMap(value=>value.results??[]);
}

async function legacyDrainCheck(options:DeployOptions,config:unknown){
  if(options.dryRun||!config||typeof config!=='object'||!('durable_objects'in config))return;
  const bindings=(config as {durable_objects?:{bindings?:{name:string}[]}}).durable_objects?.bindings;
  if(!bindings?.some(binding=>binding.name==='PI_AGENT'))return;
  const present=new Set((await query(options,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('reply_preview_run','reply_test_run','ai_execution')")).map(row=>row.name));
  const queries=['reply_preview_run','reply_test_run'].filter(table=>present.has(table)).map(table=>`SELECT count(*) AS pending FROM ${table} WHERE settlement='held' AND (receipt IS NULL OR substr(json_extract(receipt,'$.uid'),1,3)<>'pi_')`);
  if(present.has('ai_execution'))queries.push("SELECT count(*) AS pending FROM ai_execution WHERE closure IS NULL AND (receipt IS NULL OR substr(json_extract(receipt,'$.uid'),1,3)<>'pi_')");
  if(queries.length)assertLegacyRunsDrained(await query(options,queries.join(' UNION ALL ')),queries.length);
}

async function archiveRetiredResources(options: DeployOptions, config: unknown) {
  if(options.dryRun)return;
  const binding=(config as {d1_databases:{binding:string;migrations_dir?:string}[]}).d1_databases.find(value=>value.binding==='DB')!;
  const directory=resolve(dirname(options.config),binding.migrations_dir??'migrations');
  const migrations=await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')).map(name=>readFile(resolve(directory,name),'utf8')));
  const retiring=[...new Set(migrations.flatMap(retiringTables))];
  if(!retiring.length)return;
  const present=new Set((await query(options,"SELECT name FROM sqlite_master WHERE type='table'")).map(row=>row.name));
  const tables=retiring.filter(table=>present.has(table));
  if(!tables.length)return;
  const counts=await query(options,tables.map(table=>`SELECT '${table}' AS name,COUNT(*) AS records FROM "${table}"`).join(' UNION ALL '));
  assertRetirementInventory(counts,tables,options.archiveRetired===true);
  for(const table of tables){
    const plan=retirementArchivePlan(table);
    const rows=await query(options,[...plan.statements,plan.verify].join(';\n'));
    assertRetirementArchives(rows,[table]);
  }
  // Freezing the retiring sources also fences a legacy admission racing the first drain check.
  await legacyDrainCheck(options,config);
}
export async function deployCloudflare(options: DeployOptions): Promise<void> {
  const config = JSON.parse(await readFile(options.config, 'utf8')) as unknown;
  await assertBuildFresh({ root, configPath: options.config, config });
  const commands = deployArguments(options, config);
  await legacyDrainCheck(options,config);
  await archiveRetiredResources(options,config);
  for (const args of commands) {
    const code = await new Promise<number | null>((complete, reject) => {
      const child = spawn(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
        cwd: root, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      });
      child.once('error', reject);
      child.once('exit', (status, signal) => signal ? reject(new Error(`Wrangler stopped: ${signal}`)) : complete(status));
    });
    if (code !== 0) throw new Error(`Wrangler exited with ${code}; deployment stopped.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options: DeployOptions = { config: resolve(root, 'dist/dingbell/wrangler.json'), dryRun: false };
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--archive-retired') options.archiveRetired = true;
    else if ((argument === '--config' || argument === '--secrets-file') && process.argv[index + 1]) {
      const value = resolve(process.argv[++index]!);
      if (argument === '--config') options.config = value;
      else options.secretsFile = value;
    } else throw new Error(`Unsupported deployment argument: ${argument}`);
  }
  await deployCloudflare(options);
}
