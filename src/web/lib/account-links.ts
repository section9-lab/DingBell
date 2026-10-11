export function linkToken(hash: string) {
  if (!hash.startsWith('#')) return null;
  const tokens = new URLSearchParams(hash.slice(1)).getAll('token');
  return tokens.length === 1 && tokens[0]!.length > 0 && tokens[0]!.length <= 4096
    ? tokens[0]!
    : null;
}

export function invitationReturnTo(state: unknown) {
  const value = state && typeof state === 'object' && 'returnTo' in state ? state.returnTo : null;
  return typeof value === 'string' && /^\/invite\/[A-Za-z0-9_-]{1,180}$/.test(value)
    ? value
    : '/workspace';
}
