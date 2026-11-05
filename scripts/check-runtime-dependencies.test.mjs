import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeTargets, sharedDependencies, validateRuntimeLocks } from './check-runtime-dependencies.mjs';

function fixtures() {
  return runtimeTargets.map(path => {
    const dependencies = Object.fromEntries(sharedDependencies.map(name => [name, '1.4.0']));
    return { path, manifest: { dependencies }, lock: { packages: {
      '': { dependencies: { ...dependencies } },
      ...Object.fromEntries(sharedDependencies.map(name => [`node_modules/${name}`, { version: '1.4.0' }])),
    } } };
  });
}

test('matching exact runtime dependencies and lockfiles pass', () => {
  assert.deepEqual(validateRuntimeLocks(fixtures()), []);
});
test('version drift is rejected even if one target lockfile is internally consistent', () => {
  const targets = fixtures(), target = targets[2], name = sharedDependencies[0];
  target.manifest.dependencies[name] = '1.5.0';
  target.lock.packages[''].dependencies[name] = '1.5.0';
  target.lock.packages[`node_modules/${name}`].version = '1.5.0';
  assert.match(validateRuntimeLocks(targets).join('\n'), /differs from the other runtime targets/);
});
test('ranges, missing entries and stale installed versions are rejected', () => {
  const targets = fixtures();
  targets[0].manifest.dependencies[sharedDependencies[0]] = '^1.4.0';
  delete targets[1].lock.packages[''].dependencies[sharedDependencies[1]];
  targets[2].lock.packages[`node_modules/${sharedDependencies[2]}`].version = '1.3.0';
  const errors = validateRuntimeLocks(targets).join('\n');
  assert.match(errors, /must be pinned to an exact version/);
  assert.equal((errors.match(/manifest and lockfile do not agree/g) ?? []).length, 2);
});
