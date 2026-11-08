/**
 * Company role helpers shared by the browser and the server.
 *
 * better-auth persists `member.role` as either a single role or a comma-separated
 * list. Every authorization check must therefore parse the list instead of
 * comparing the raw string, otherwise `owner,admin` silently loses its powers.
 */

/** Roles allowed to administer a company (members, stores, knowledge, policies). */
export const MANAGER_ROLES = ['owner', 'admin'] as const;

export function parseRoles(value: string): string[] {
  return value
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
}

export function hasRole(value: string, ...allowed: readonly string[]): boolean {
  if (!allowed.length) return false;
  const roles = new Set(parseRoles(value));
  return allowed.some((role) => roles.has(role));
}

export function isOwner(value: string): boolean {
  return hasRole(value, 'owner');
}

export function canManageCompany(value: string): boolean {
  return hasRole(value, ...MANAGER_ROLES);
}
