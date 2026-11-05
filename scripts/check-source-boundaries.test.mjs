import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasNodeModulesImport } from './check-source-boundaries.mjs';

test('detects direct, dynamic and require imports of another installation', () => {
  for (const source of [
    "import { x } from '../../node_modules/pkg/dist/x.js';",
    "const x = await import('../node_modules/pkg/x.js');",
    "const x = require('../node_modules/pkg/x.js');",
  ]) assert.equal(hasNodeModulesImport(source), true, source);
});

test('permits package subpath exports and unrelated node_modules text', () => {
  for (const source of ["import { x } from 'pkg/subpath';", "const dir = 'node_modules';"]) {
    assert.equal(hasNodeModulesImport(source), false, source);
  }
});
