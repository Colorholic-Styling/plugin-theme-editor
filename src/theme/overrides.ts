import type { PluginEnv } from '../types';

/**
 * Per-template section visibility.
 *
 * Hiding a section is a theme-template decision rather than page content, so it
 * cannot live in a page's `lect`; and the theme bundle is a read-only asset
 * subtree that `npm run theme:sync` regenerates from the theme repository, so
 * the template file cannot be written back either. This is the writable layer
 * between the two.
 *
 * Hidden keys are stored instead of a copy of the template's `order` array: a
 * theme author who adds a section later gets it shown, rather than silently
 * losing it to a stale snapshot taken when someone first hid something.
 */
export class MissingOverrideStoreError extends Error {
  constructor() {
    super('Section visibility needs the THEME_OVERRIDES KV namespace. '
      + 'Provision it with `npm run kv:setup -- --binding=THEME_OVERRIDES`.');
    this.name = 'MissingOverrideStoreError';
  }
}

/**
 * Visible-by-default: an unprovisioned or unreachable store must not blank out
 * a preview, so reads degrade to "nothing hidden" while writes fail loudly.
 */
export async function hiddenSections(
  env: PluginEnv,
  themeId: string,
  templateId: string,
): Promise<Set<string>> {
  if (!env.THEME_OVERRIDES) return new Set();
  const stored = await env.THEME_OVERRIDES.get(overrideKey(env, themeId, templateId));
  return new Set(parseHidden(stored));
}

export async function setSectionHidden(
  env: PluginEnv,
  themeId: string,
  templateId: string,
  section: string,
  hidden: boolean,
): Promise<Set<string>> {
  if (!env.THEME_OVERRIDES) throw new MissingOverrideStoreError();
  const key = overrideKey(env, themeId, templateId);
  const current = new Set(parseHidden(await env.THEME_OVERRIDES.get(key)));
  if (hidden) current.add(section);
  else current.delete(section);
  await env.THEME_OVERRIDES.put(key, JSON.stringify({ hidden: [...current].sort() }));
  return current;
}

/**
 * Keyed by the tenant's CMS origin, which `tenantClientEnv` resolves from the
 * authenticated registry row, so one plugin Worker serving several CMS hosts
 * keeps their overrides apart.
 */
function overrideKey(env: PluginEnv, themeId: string, templateId: string): string {
  const tenant = (env.CMS_URL || 'local').replace(/\/+$/, '');
  return `sections:${tenant}:${themeId}:${templateId}`;
}

function parseHidden(stored: string | null): string[] {
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const { hidden } = parsed as { hidden?: unknown };
    return Array.isArray(hidden)
      ? hidden.filter((key): key is string => typeof key === 'string')
      : [];
  } catch {
    return [];
  }
}
