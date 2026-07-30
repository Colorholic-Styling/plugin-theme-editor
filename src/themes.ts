import { ADMIN_BASE } from './constants';
import type { PluginEnv } from './types';
import { parseRepo, type GitHubRepo } from './theme/github';
import {
  AssetThemeStore,
  bucketThemeIds,
  R2ThemeStore,
  type ThemeStore,
} from './theme/store';

export interface ThemeDefinition {
  id: string;
  name: string;
  description: string;
  source: string;
  status: string;
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
 * Worker. Without a bucket the development theme staged under the built asset
 * tree at `.dist/views/theme/`
 * stands in, which is what `npm run dev` uses.
 */
export async function availableThemes(env: PluginEnv): Promise<ThemeDefinition[]> {
  if (!env.THEMES) return availableDevelopmentTheme(env);

  const ids = await bucketThemeIds(env.THEMES);
  if (ids.length === 0) return availableDevelopmentTheme(env);

  const themes = await Promise.all(ids.map(async (id) => {
    const meta = await themeMetadata(new R2ThemeStore(env.THEMES as R2Bucket, id));
    return {
      id,
      name: meta.name || humanize(id),
      description: meta.description || 'A theme stored in the theme bucket.',
      source: meta.repo
        ? `${meta.repo.owner}/${meta.repo.repo}@${meta.repo.branch}`
        : `Bucket ${id}/`,
      status: meta.repo ? 'GitHub' : 'Bucket',
      assetPrefix: '',
      storage: 'bucket' as const,
      repo: meta.repo,
    };
  }));
  return themes;
}

/** A clean production build contains no local theme, even when its bucket is empty. */
async function availableDevelopmentTheme(env: PluginEnv): Promise<ThemeDefinition[]> {
  const theme = developmentTheme(env);
  return await themeStore(env, theme).exists('/theme-manifest.json') ? [theme] : [];
}

export async function themeFromId(
  env: PluginEnv,
  requestedId: string | null,
): Promise<ThemeDefinition | null> {
  const themes = await availableThemes(env);
  if (!requestedId) return themes[0] ?? null;
  return themes.find((theme) => theme.id === requestedId) ?? null;
}

/** The store a theme reads through, writable only when it lives in the bucket. */
export function themeStore(env: PluginEnv, theme: ThemeDefinition): ThemeStore {
  return theme.storage === 'bucket' && env.THEMES
    ? new R2ThemeStore(env.THEMES, theme.id)
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
    source: 'Local .dist/views/theme',
    status: 'Development',
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
