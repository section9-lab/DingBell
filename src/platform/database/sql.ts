import { MANAGER_ROLES } from '../../shared/roles.ts';

/**
 * SQLite expression for "now" as integer milliseconds with sub-second precision.
 * This is the canonical form: the second-precision variant below truncates and
 * must only be used where the original code already did so.
 */
export const NOW_MS = "CAST(unixepoch('subsecond')*1000 AS INTEGER)";

/** SQLite expression for "now" as integer milliseconds derived from whole seconds. */
export const NOW_MS_WHOLE_SECONDS = 'unixepoch()*1000';

const ROLE_NAME = /^[a-z][a-z0-9_]*$/;

function assertRole(role: string): void {
  if (!ROLE_NAME.test(role)) throw new RangeError('INVALID_ROLE_NAME');
}

/**
 * SQL predicate that is true when `column` holds `role`.
 * Handles better-auth's comma-separated role lists without matching substrings
 * (`',admin,'` never matches `superadmin`).
 */
export function sqlHasRole(column: string, role: string): string {
  assertRole(role);
  return `instr(',' || ${column} || ',', ',${role},') > 0`;
}

/** SQL predicate that is true for owners and administrators. */
export function sqlManagesCompany(column: string): string {
  return `(${MANAGER_ROLES.map((role) => sqlHasRole(column, role)).join(' OR ')})`;
}
