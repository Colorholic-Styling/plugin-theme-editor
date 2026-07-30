/**
 * A theme's manifest, derived from the files it contains.
 *
 * `theme:sync` writes one when staging the development theme, but a theme
 * repository has no reason to contain it — it is a build product. A theme
 * arriving from GitHub or an upload therefore gets one generated here, so it is
 * usable the moment it lands rather than presenting as a theme with no
 * templates.
 */
export interface ThemeManifest {
  templates: Array<{ id: string; label: string; path: string; format: 'json' | 'liquid' }>;
  files: string[];
}

const TEMPLATE_PATH = /^\/templates\/([a-z0-9][a-z0-9-]*)\.(json|liquid)$/;

export function buildThemeManifest(
  paths: string[],
  extra: Record<string, unknown> = {},
): string {
  const files = [...new Set(paths.filter((path) => /\.(liquid|json)$/.test(path)))]
    .filter((path) => path !== '/theme-manifest.json')
    .sort();

  const templates = files.flatMap((path) => {
    const match = TEMPLATE_PATH.exec(path);
    if (!match) return [];
    const [, id, format] = match;
    return [{
      id,
      label: humanize(id),
      path,
      format: format as 'json' | 'liquid',
    }];
  });

  // `extra` first so generated lists always win over a stale copy of them,
  // while a theme's own name, description, and repo survive.
  return `${JSON.stringify({ ...extra, templates, files }, null, 2)}\n`;
}

function humanize(value: string): string {
  return value.split('-').map((part) => part
    ? part[0].toUpperCase() + part.slice(1)
    : '').join(' ');
}
