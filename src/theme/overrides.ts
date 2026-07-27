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
export interface TemplateOverrides {
  /** Section keys dropped from the template's compiled `order`. */
  hidden: string[];
  /** Per section key, the Liquid each declared setting binds to. */
  settings: Record<string, Record<string, string>>;
}

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
export async function templateOverrides(
  env: PluginEnv,
  themeId: string,
  templateId: string,
): Promise<TemplateOverrides> {
  if (!env.THEME_OVERRIDES) return { hidden: [], settings: {} };
  return parseOverrides(await env.THEME_OVERRIDES.get(overrideKey(env, themeId, templateId)));
}

export async function hiddenSections(
  env: PluginEnv,
  themeId: string,
  templateId: string,
): Promise<Set<string>> {
  return new Set((await templateOverrides(env, themeId, templateId)).hidden);
}

/** Every template's overrides, for tooling that writes them into the theme. */
export async function allTemplateOverrides(
  env: PluginEnv,
  themeId: string,
  templateIds: string[],
): Promise<Record<string, TemplateOverrides>> {
  const entries = await Promise.all(templateIds.map(async (templateId) =>
    [templateId, await templateOverrides(env, themeId, templateId)] as const));
  return Object.fromEntries(entries.filter(([, value]) =>
    value.hidden.length > 0 || Object.keys(value.settings).length > 0));
}

/**
 * Drops a template's overrides once they have been written into the theme
 * itself, so the theme file is the only thing saying what it says.
 */
export async function clearTemplateOverrides(
  env: PluginEnv,
  themeId: string,
  templateId: string,
): Promise<void> {
  if (!env.THEME_OVERRIDES) throw new MissingOverrideStoreError();
  await env.THEME_OVERRIDES.delete(overrideKey(env, themeId, templateId));
}

/**
 * Rewrites what a declared section's settings bind to. The theme's own template
 * file is a read-only asset that `theme:sync` regenerates, so an edit made here
 * is layered over it rather than written into it.
 */
export async function setSectionSettings(
  env: PluginEnv,
  themeId: string,
  templateId: string,
  sectionKey: string,
  settings: Record<string, string>,
): Promise<TemplateOverrides> {
  if (!env.THEME_OVERRIDES) throw new MissingOverrideStoreError();
  const key = overrideKey(env, themeId, templateId);
  const current = parseOverrides(await env.THEME_OVERRIDES.get(key));
  const next: TemplateOverrides = {
    ...current,
    settings: { ...current.settings, [sectionKey]: settings },
  };
  // An empty map is the absence of an override, not an override to nothing.
  if (Object.keys(settings).length === 0) delete next.settings[sectionKey];
  await env.THEME_OVERRIDES.put(key, JSON.stringify(next));
  return next;
}

/** Returns exactly what was stored, so a caller cannot report a different set. */
export async function setSectionHidden(
  env: PluginEnv,
  themeId: string,
  templateId: string,
  section: string,
  hidden: boolean,
): Promise<string[]> {
  if (!env.THEME_OVERRIDES) throw new MissingOverrideStoreError();
  const key = overrideKey(env, themeId, templateId);
  const current = parseOverrides(await env.THEME_OVERRIDES.get(key));
  const keys = new Set(current.hidden);
  if (hidden) keys.add(section);
  else keys.delete(section);
  const stored = [...keys].sort();
  await env.THEME_OVERRIDES.put(key, JSON.stringify({ ...current, hidden: stored }));
  return stored;
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

function parseOverrides(stored: string | null): TemplateOverrides {
  const empty: TemplateOverrides = { hidden: [], settings: {} };
  if (!stored) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return empty;
  }
  if (!isRecord(parsed)) return empty;

  const settings: Record<string, Record<string, string>> = {};
  if (isRecord(parsed.settings)) {
    for (const [section, values] of Object.entries(parsed.settings)) {
      if (!isRecord(values)) continue;
      settings[section] = Object.fromEntries(
        Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
    }
  }
  return {
    hidden: Array.isArray(parsed.hidden)
      ? parsed.hidden.filter((key): key is string => typeof key === 'string')
      : [],
    settings,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
