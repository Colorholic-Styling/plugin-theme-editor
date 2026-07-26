export interface ThemeEditorAccess {
  canView: boolean;
  canEdit: boolean;
}

const FULL_ACCESS: ThemeEditorAccess = { canView: true, canEdit: true };

export function themeEditorAccessForRequest(request: Request): ThemeEditorAccess {
  const user = cmsUser(request);
  // Direct secret-authenticated local tooling predates x-cms-user forwarding.
  if (!user) return { ...FULL_ACCESS };

  const roles = split(user.role);
  if (roles.includes('admin') || roles.includes('editor')) return { ...FULL_ACCESS };

  const permissions = Array.isArray(user.permissions)
    ? user.permissions.filter((value): value is string => typeof value === 'string')
    : split(user.permissions);
  const normalized = permissions.map((value) => value.trim().toLowerCase());
  const canEdit = normalized.includes('theme-editor:write');
  return {
    canEdit,
    canView: canEdit || normalized.includes('theme-editor:view'),
  };
}

export function actingUserId(request: Request): string {
  const user = cmsUser(request);
  if (!user) return '';
  return typeof user.id === 'string' || typeof user.id === 'number' ? String(user.id) : '';
}

function cmsUser(request: Request): {
  id?: unknown;
  role?: unknown;
  permissions?: unknown;
} | null {
  const raw = request.headers.get('x-cms-user');
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as { id?: unknown; role?: unknown; permissions?: unknown }
      : null;
  } catch {
    return null;
  }
}

function split(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
}

export function forbidden(): Response {
  return new Response('Forbidden', { status: 403, headers: { 'cache-control': 'no-store' } });
}

