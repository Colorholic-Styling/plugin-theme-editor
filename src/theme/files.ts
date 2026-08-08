/**
 * Theme file policy shared by bucket uploads, asset serving, and manifests.
 *
 * A theme checkout is usually a repository, not a clean export. Keep VCS
 * metadata, package files, source maps, and arbitrary documents out of the
 * theme library; only these trees are part of the renderer contract.
 */
export const THEME_DIRECTORIES = ['assets', 'layout', 'sections', 'snippets', 'templates'] as const;

const THEME_EXTENSION = /\.(liquid|json|css|js|svg|png|jpe?g|webp|ico|woff2?)$/i;
const BINARY_EXTENSION = /\.(png|jpe?g|webp|ico|woff2?)$/i;

/** Paths are store-relative and must begin with a slash. */
export function isThemeFilePath(path: string): boolean {
  if (path === '/theme-manifest.json') return true;
  if (!/^\/[a-z0-9][a-z0-9._/-]*$/i.test(path) || path.includes('..')) return false;
  const relative = path.slice(1);
  const directory = relative.split('/')[0];
  return THEME_DIRECTORIES.includes(directory as typeof THEME_DIRECTORIES[number])
    && THEME_EXTENSION.test(relative);
}

export function isBinaryThemePath(path: string): boolean {
  return BINARY_EXTENSION.test(path);
}

export function themeContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.css')) return 'text/css';
  if (lower.endsWith('.js')) return 'text/javascript';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.ico')) return 'image/x-icon';
  if (lower.endsWith('.woff')) return 'font/woff';
  if (lower.endsWith('.woff2')) return 'font/woff2';
  return 'text/plain; charset=utf-8';
}
