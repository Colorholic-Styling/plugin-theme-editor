import type { PluginEnv } from '../types';
import type { ThemeDefinition } from '../themes';
import { themeStore } from '../themes';

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
  const files = isRecord(manifest) && Array.isArray(manifest.files)
    ? manifest.files.filter(isThemePath)
    : [];

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
 * Paths come from the generated manifest rather than a request, but they still
 * address an asset binding, so keep traversal and odd names out of the read.
 */
function isThemePath(value: unknown): value is string {
  return typeof value === 'string'
    && /^\/[a-z0-9][a-z0-9./_-]*\.(liquid|json)$/.test(value)
    && !value.includes('..');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
