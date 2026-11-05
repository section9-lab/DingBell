import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// These three isolated targets must execute the same Pi protocol. The root
// legacy Flue SDK intentionally uses a different version and is not included.
export const runtimeTargets = ['packages/agent-runtime', 'deploy/cloudflare', 'deploy/vercel'];
export const sharedDependencies = ['@earendil-works/chord', '@earendil-works/pi-ai', '@earendil-works/pi-durable'];

export function validateRuntimeLocks(targets) {
  const failures = [];
  const expected = new Map();
  for (const { path, manifest, lock } of targets) {
    for (const name of sharedDependencies) {
      const declared = manifest.dependencies?.[name];
      const recorded = lock.packages?.['']?.dependencies?.[name];
      const installed = lock.packages?.[`node_modules/${name}`]?.version;
      if (typeof declared !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(declared)) {
        failures.push(`${path}: ${name} must be pinned to an exact version`);
      } else {
        if (recorded !== declared || installed !== declared) failures.push(`${path}: ${name} manifest and lockfile do not agree`);
        if (!expected.has(name)) expected.set(name, declared);
        else if (expected.get(name) !== declared) failures.push(`${path}: ${name} differs from the other runtime targets`);
      }
    }
  }
  return failures;
}

export async function checkRuntimeDependencies(root) {
  const targets = await Promise.all(runtimeTargets.map(async path => ({
    path,
    manifest: JSON.parse(await readFile(resolve(root, path, 'package.json'), 'utf8')),
    lock: JSON.parse(await readFile(resolve(root, path, 'package-lock.json'), 'utf8')),
  })));
  return validateRuntimeLocks(targets);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const failures = await checkRuntimeDependencies(resolve(import.meta.dirname, '..'));
    if (failures.length) {
      console.error(`Runtime dependency check failed:\n- ${failures.join('\n- ')}`);
      process.exitCode = 1;
    } else console.log('Isolated runtime dependency versions and lockfiles agree.');
  } catch (error) {
    console.error('Runtime dependency check could not read all manifests and lockfiles.', error);
    process.exitCode = 1;
  }
}
