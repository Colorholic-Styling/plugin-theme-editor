import { ADMIN_BASE } from './constants';
import type { PluginEnv } from './types';
import { parseRepo, type GitHubRepo } from './theme/github';
import {
  AssetThemeStore,
  bucketThemeIds,
  R2ThemeStore,
  type ThemeScope,
  type ThemeStore,
} from './theme/store';

export interface ThemeDefinition {
  id: string;
  name: string;
  description: string;
  /** Translation key for a built-in description; theme-authored text stays as-is. */
  descriptionKey?: string;
  source: string;
  status: string;
  /** Translation key for a built-in storage/status label. */
  statusKey?: string;
  /** Path prefix inside the asset bundle; unused by bucket-backed themes. */
  assetPrefix: string;
  /** Where the theme's files live, and whether the Worker may write them. */
  storage: 'asset' | 'bucket';
  /** Set when the theme was cloned from GitHub, so it can be pushed back. */
  repo: GitHubRepo | null;
}

/**
 * The bucket is the root of the theme library: every top-level folder is a
 * theme, so publishing one is uploading a folder rather than changing this
 * Worker. Local development can stage one legacy theme at `.dist/views/theme/`
 * or a registry of checkouts at `.dist/views/themes/<id>/`.
 */
export async function availableThemes(env: PluginEnv): Promise<ThemeDefinition[]> {
  const local = await availableLocalThemes(env);
  const ids = env.THEMES
    ? await bucketThemeIds(env.THEMES, themeScope(env))
    : [];
  const bucketThemes = await Promise.all(ids.map(async (id) => {
    const meta = await themeMetadata(new R2ThemeStore(env.THEMES as R2Bucket, id, themeScope(env)));
    return {
      id,
      name: meta.name || humanize(id),
      description: meta.description || 'A theme stored in the theme bucket.',
      descriptionKey: meta.description ? undefined : 'plugins.theme-editor.themes.description_bucket',
      source: meta.repo
        ? `${meta.repo.owner}/${meta.repo.repo}@${meta.repo.branch}`
        : `Bucket ${id}/`,
      status: meta.repo ? 'GitHub' : 'Bucket',
      statusKey: meta.repo
        ? 'plugins.theme-editor.themes.status_github'
        : 'plugins.theme-editor.themes.status_bucket',
      assetPrefix: '',
      storage: 'bucket' as const,
      repo: meta.repo,
    };
  }));

  // A bucket and local registry are independent sources. R2 wins on a
  // duplicate id so an explicitly published theme cannot be shadowed by a
  // stale local checkout. The legacy fallback is retained for empty buckets
  // and for deployments that have no generated local catalog.
  if (bucketThemes.length > 0) {
    const bucketIds = new Set(bucketThemes.map((theme) => theme.id));
    return [...bucketThemes, ...local.themes.filter((theme) => !bucketIds.has(theme.id))];
  }
  if (local.catalogFound) return local.themes;
  return availableDevelopmentTheme(env);
}

/** A clean production build contains no local theme, even when its bucket is empty. */
async function availableDevelopmentTheme(env: PluginEnv): Promise<ThemeDefinition[]> {
  const theme = developmentTheme(env);
  return await themeStore(env, theme).exists('/theme-manifest.json') ? [theme] : [];
}

/**
 * The asset binding cannot list directories. `theme:sync` therefore emits a
 * small catalog beside the generated `themes/<id>` folders. A missing catalog
 * means the caller is using the backwards-compatible single-theme layout.
 */
async function availableLocalThemes(
  env: PluginEnv,
): Promise<{ themes: ThemeDefinition[]; catalogFound: boolean }> {
  const catalog = await readLocalCatalog(env.VIEWS);
  if (!catalog) return { themes: [], catalogFound: false };

  const themes = await Promise.all(catalog.map(async (entry) => {
    const theme: ThemeDefinition = {
      id: entry.id,
      name: entry.name || humanize(entry.id),
      description: entry.description || `Local checkout staged under .dist/views/themes/${entry.id}.`,
      descriptionKey: undefined,
      source: entry.source || `Local .dist/views/themes/${entry.id}`,
      status: 'Development',
      statusKey: 'plugins.theme-editor.themes.status_development',
      assetPrefix: entry.assetPrefix,
      storage: 'asset',
      repo: null,
    };
    return await themeStore(env, theme).exists('/theme-manifest.json') ? theme : null;
  }));
  return {
    themes: themes.filter((theme): theme is ThemeDefinition => theme !== null),
    catalogFound: true,
  };
}

interface LocalThemeCatalogEntry {
  id: string;
  name?: string;
  description?: string;
  assetPrefix: string;
  source?: string;
}

async function readLocalCatalog(assets: Fetcher): Promise<LocalThemeCatalogEntry[] | null> {
  let response: Response;
  try {
    response = await assets.fetch('https://views.local/theme-catalog.json');
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    const parsed = await response.json() as unknown;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { themes?: unknown }).themes)) {
      return [];
    }
    const seen = new Set<string>();
    return (parsed as { themes: unknown[] }).themes.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const entry = value as Record<string, unknown>;
      const id = typeof entry.id === 'string' ? entry.id : '';
      const assetPrefix = typeof entry.assetPrefix === 'string' ? entry.assetPrefix : '';
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || id === 't' || seen.has(id)) return [];
      if (!/^\/theme$|^\/themes\/[a-z0-9][a-z0-9-]*$/.test(assetPrefix)) return [];
      if (assetPrefix !== '/theme' && assetPrefix !== `/themes/${id}`) return [];
      seen.add(id);
      return [{
        id,
        assetPrefix,
        ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
        ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
        ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
      }];
    });
  } catch {
    // A malformed generated catalog should not make every admin route fail.
    return [];
  }
}

export async function themeFromId(
  env: PluginEnv,
  requestedId: string | null,
): Promise<ThemeDefinition | null> {
  const themes = await availableThemes(env);
  if (!requestedId) return themes[0] ?? null;
  return themes.find((theme) => theme.id === requestedId) ?? null;
}

/**
 * Which tenant's themes this request may see. Derived from the tenant the host
 * request authenticated as, so a theme can never be addressed across tenants:
 * the ref is not a caller-supplied value.
 */
export function themeScope(env: PluginEnv): ThemeScope {
  return {
    tenantRef: env.CMS_TENANT_REF?.trim() || undefined,
    legacy: env.CMS_TENANT_LEGACY === '1',
  };
}

/** The store a theme reads through, writable only when it lives in the bucket. */
export function themeStore(env: PluginEnv, theme: ThemeDefinition): ThemeStore {
  return theme.storage === 'bucket' && env.THEMES
    ? new R2ThemeStore(env.THEMES, theme.id, themeScope(env))
    : new AssetThemeStore(env.VIEWS, theme.assetPrefix);
}

export function themeEditorHref(theme: ThemeDefinition, templateId = ''): string {
  const href = `${ADMIN_BASE}/editor?theme=${encodeURIComponent(theme.id)}`;
  return templateId
    ? `${href}&template=${encodeURIComponent(templateId)}`
    : href;
}

function developmentTheme(env: PluginEnv): ThemeDefinition {
  return {
    id: env.THEME_ID || 'development',
    name: env.THEME_NAME || 'Development Theme',
    description: 'The local development theme staged under .dist/views/theme.',
    descriptionKey: 'plugins.theme-editor.themes.description_development',
    source: 'Local .dist/views/theme',
    status: 'Development',
    statusKey: 'plugins.theme-editor.themes.status_development',
    assetPrefix: '/theme',
    storage: 'asset',
    repo: null,
  };
}

/** A theme names itself in its own manifest, so the bucket stays the registry. */
async function themeMetadata(
  store: ThemeStore,
): Promise<{ name: string; description: string; repo: GitHubRepo | null }> {
  const empty = { name: '', description: '', repo: null };
  try {
    const parsed = JSON.parse(await store.read('/theme-manifest.json')) as unknown;
    if (!parsed || typeof parsed !== 'object') return empty;
    const { name, description, repo } = parsed as {
      name?: unknown; description?: unknown; repo?: unknown;
    };
    return {
      name: typeof name === 'string' ? name : '',
      description: typeof description === 'string' ? description : '',
      repo: repo && typeof repo === 'object' ? parseRepo(repo as Record<string, string>) : null,
    };
  } catch {
    return empty;
  }
}

function humanize(value: string): string {
  return value.split('-').map((part) => part
    ? part[0].toUpperCase() + part.slice(1)
    : '').join(' ');
}
