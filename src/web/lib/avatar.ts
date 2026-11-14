const avatarPrefix = '/api/avatars/';
const avatarSuffix = '.svg';

/** A stable, opaque seed for accounts that have not picked an avatar yet. */
export function defaultAvatarSeed(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `u-${(hash >>> 0).toString(36)}`;
}

export function randomAvatarSeed() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function avatarUrl(seed: string) {
  return `${avatarPrefix}${encodeURIComponent(seed)}${avatarSuffix}`;
}

/** A saved image wins; otherwise the seed is already final and must not be hashed again. */
export function avatarSrc(image: string | null | undefined, seed: string | undefined) {
  return image || (seed ? avatarUrl(seed) : null);
}

export function avatarSeedFromImage(image: string | null | undefined, fallback: string) {
  if (!image?.startsWith(avatarPrefix) || !image.endsWith(avatarSuffix)) return fallback;
  try {
    const seed = decodeURIComponent(image.slice(avatarPrefix.length, -avatarSuffix.length));
    return /^[A-Za-z0-9_-]{1,64}$/.test(seed) ? seed : fallback;
  } catch {
    return fallback;
  }
}
