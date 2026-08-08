import type { PluginEnv } from '../types';
import type { ThemeDefinition } from '../themes';
import { themeStore } from '../themes';
import { isWritable } from './store';

/**
 * The theme's Liquid sources keyed by the path the renderer resolves, so the
 * browser can serve them from memory through the same `ThemeStore` interface
 * the Worker uses against its asset binding.
 */
export async function themeBundle(
  env: PluginEnv,
  theme: ThemeDefinition,
): Promise<Record<string, string>> {
  const store = themeStore(env, theme);
  const manifest = JSON.parse(await store.read('/theme-manifest.json')) as unknown;
  const manifestFiles = isRecord(manifest) && Array.isArray(manifest.files)
    ? manifest.files.filter(isThemePath)
    : [];

  // R2 themes can also be updated by a checkout's own push script. Such a
  // script may upload a new Liquid partial without rewriting the generated
  // manifest, which would otherwise leave the browser preview with a stale
  // bundle and make `{% render %}` report a misleading missing-file error.
  // Listing is scoped by R2ThemeStore to this tenant and theme, so it is safe
  // to union the current objects with the manifest. Asset-backed themes do
  // not expose a list capability and continue to use their generated manifest.
  const listedFiles = isWritable(store)
    ? await store.list().catch(() => [])
    : [];
  const files = [...new Set([
    ...manifestFiles,
    ...listedFiles.filter(isThemePath),
  ])];

  const sources = await Promise.all(files.map(async (path) => {
    try {
      return [path, await store.read(path)] as const;
    } catch {
      return null;
    }
  }));
  return Object.fromEntries(sources.filter((entry): entry is readonly [string, string] => entry !== null));
}

/**
 * Paths come from the generated manifest or a scoped bucket listing rather than
 * a request, but they still address an asset binding, so keep traversal and
 * odd names out of the read.
 */
function isThemePath(value: unknown): value is string {
  return typeof value === 'string'
    && value !== '/theme-manifest.json'
    && /^\/[a-z0-9][a-z0-9./_-]*\.(liquid|json)$/.test(value)
    && !value.includes('..');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
