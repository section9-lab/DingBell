import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const webRoot = fileURLToPath(new URL('../src/web/', import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'ui' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : [];
  });
}

test('every store-list query uses the shared key factory instead of a bespoke literal', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(webRoot)) {
    const source = readFileSync(file, 'utf8');
    // Any component reading the store list is company-scoped and must share its cache entry.
    if (!/\breadStores\(/.test(source)) continue;
    // The API module defines the reader; only query call sites are constrained.
    if (!/\b(useQuery|useInfiniteQuery)\s*[<(]/.test(source)) continue;
    if (!/\b(storesQueryKey|storesInfiniteQueryKey)\(/.test(source)) {
      violations.push(file.slice(webRoot.length));
      continue;
    }
    if (/queryKey:\s*\[\s*'(?:commerce-stores|activity-stores|message-stores|policy-stores|knowledge-stores|stores)'/.test(source)) {
      violations.push(`${file.slice(webRoot.length)} (legacy literal)`);
    }
  }
  assert.deepEqual(violations, [], `store queries must use src/web/lib/query-keys.ts: ${violations.join(', ')}`);
});

test('company-scoped keys never embed the tenant in a stringified blob alone', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(webRoot)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/queryKey:\s*\[([^\]]*)\]/g)) {
      const body = match[1]!;
      if (!/companyId|company\.id/.test(body)) continue;
      // The tenant must appear as its own array element so realtime invalidation can match it.
      if (/JSON\.stringify\(\s*\{[^}]*company/.test(body)) violations.push(file.slice(webRoot.length));
    }
  }
  assert.deepEqual([...new Set(violations)], []);
});
