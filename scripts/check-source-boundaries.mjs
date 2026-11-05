import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Importing another package's installation directory bypasses package exports
// and silently relies on npm's disk layout. Platform bridges own those imports.
export function hasNodeModulesImport(source) {
  return /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"][^'"]*\bnode_modules\//.test(source);
}

export async function findBoundaryViolations(root, directories = ['src', 'packages', 'deploy', 'probes']) {
  const failures = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)
        && hasNodeModulesImport(await readFile(path, 'utf8'))) failures.push(relative(root, path));
    }
  }
  for (const directory of directories) await visit(resolve(root, directory));
  return failures.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const failures = await findBoundaryViolations(resolve(import.meta.dirname, '..'));
    if (failures.length) {
      console.error(`Imports through node_modules are forbidden:\n- ${failures.join('\n- ')}`);
      process.exitCode = 1;
    } else console.log('Source imports respect package export boundaries.');
  } catch (error) {
    console.error('Source boundary check failed.', error);
    process.exitCode = 1;
  }
}
