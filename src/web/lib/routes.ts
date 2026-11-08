/**
 * Single source of truth for workspace paths and sections.
 *
 * Navigation, the command palette and the router all read from here so a path
 * rename cannot leave a dead link behind.
 */
export const workspaceRoutes = {
  home: '/workspace',
  messages: '/workspace/messages',
  products: '/workspace/products',
  orders: '/workspace/orders',
  accounting: '/workspace/accounting',
  activity: '/workspace/activity',
  capabilities: '/workspace/capabilities',
  knowledge: '/workspace/knowledge',
  policies: '/workspace/reply-policies',
  stores: '/workspace/stores',
  team: '/workspace/team',
  settings: '/workspace/settings',
} as const;

export type WorkspaceSection = keyof typeof workspaceRoutes;

const sectionsByPath = new Map<string, WorkspaceSection>(
  Object.entries(workspaceRoutes).map(([section, path]) => [path, section as WorkspaceSection]),
);

/** Resolves the current workspace section; unknown paths fall back to the home view. */
export function workspaceSection(pathname: string): WorkspaceSection {
  return sectionsByPath.get(pathname) ?? 'home';
}

/** True for the workspace shell and every page rendered inside it. */
export function isWorkspacePath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === workspaceRoutes.home ||
    pathname.startsWith(`${workspaceRoutes.home}/`)
  );
}
