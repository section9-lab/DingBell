import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
export type DeployOptions = { config: string; dryRun: boolean; secretsFile?: string };

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

async function legacyDrainCheck(options:DeployOptions,config:unknown){
  if(options.dryRun||!config||typeof config!=='object'||!('durable_objects'in config))return;
  const bindings=(config as {durable_objects?:{bindings?:{name:string}[]}}).durable_objects?.bindings;
  if(!bindings?.some(binding=>binding.name==='PI_AGENT'))return;
  async function query(sql:string):Promise<Record<string,unknown>[]>{
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
  const present=new Set((await query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('reply_preview_run','reply_test_run','ai_execution')")).map(row=>row.name));
  const queries=['reply_preview_run','reply_test_run'].filter(table=>present.has(table)).map(table=>`SELECT count(*) AS pending FROM ${table} WHERE settlement='held' AND (receipt IS NULL OR substr(json_extract(receipt,'$.uid'),1,3)<>'pi_')`);
  if(present.has('ai_execution'))queries.push("SELECT count(*) AS pending FROM ai_execution WHERE closure IS NULL AND (receipt IS NULL OR substr(json_extract(receipt,'$.uid'),1,3)<>'pi_')");
  if(queries.length)assertLegacyRunsDrained(await query(queries.join(' UNION ALL ')),queries.length);
}
export async function deployCloudflare(options: DeployOptions): Promise<void> {
  const config = JSON.parse(await readFile(options.config, 'utf8')) as unknown;
  const commands = deployArguments(options, config);
  await legacyDrainCheck(options,config);
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
    else if ((argument === '--config' || argument === '--secrets-file') && process.argv[index + 1]) {
      const value = resolve(process.argv[++index]!);
      if (argument === '--config') options.config = value;
      else options.secretsFile = value;
    } else throw new Error(`Unsupported deployment argument: ${argument}`);
  }
  await deployCloudflare(options);
}
