import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  avatarSeedFromImage,
  avatarSrc,
  avatarUrl,
  defaultAvatarSeed,
  randomAvatarSeed,
} from './avatar.ts';

test('default avatar seeds are stable and URL-safe', () => {
  assert.equal(defaultAvatarSeed('user-1'), defaultAvatarSeed('user-1'));
  assert.notEqual(defaultAvatarSeed('user-1'), defaultAvatarSeed('user-2'));
  assert.match(defaultAvatarSeed('user-1'), /^[A-Za-z0-9_-]{1,64}$/);
});

test('random avatar seeds are URL-safe and unique enough for a picker', () => {
  const seeds = new Set(Array.from({ length: 50 }, randomAvatarSeed));
  assert.equal(seeds.size, 50);
  for (const seed of seeds) assert.match(seed, /^[A-Za-z0-9_-]{1,64}$/);
});

test('an explicit avatar seed is rendered directly, never hashed again', () => {
  assert.equal(avatarSrc(null, 'abc_123'), '/api/avatars/abc_123.svg');
  assert.notEqual(avatarSrc(null, 'abc_123'), avatarUrl(defaultAvatarSeed('abc_123')));
  assert.equal(avatarSrc('/api/avatars/saved.svg', 'abc_123'), '/api/avatars/saved.svg');
  assert.equal(avatarSrc(null, undefined), null);
});

test('avatar URL parsing only unwraps our own valid image URLs', () => {
  const fallback = 'u-default';
  assert.equal(avatarSeedFromImage(avatarUrl('abc_123-xyz'), fallback), 'abc_123-xyz');
  assert.equal(avatarSeedFromImage(null, fallback), fallback);
  assert.equal(avatarSeedFromImage('/other/abc.svg', fallback), fallback);
  assert.equal(avatarSeedFromImage('/api/avatars/bad.seed.svg', fallback), fallback);
  assert.equal(avatarSeedFromImage('/api/avatars/%E0%A4%A.svg', fallback), fallback);
});
