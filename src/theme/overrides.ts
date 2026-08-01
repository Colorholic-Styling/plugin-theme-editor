import { CmsNotConfiguredError, pluginState } from '@lionrockjs/worker-cms-plugin';
import { PLUGIN_ID } from '../constants';
import type { PluginEnv } from '../types';

/**
 * Per-template section visibility, order, additions, and setting bindings.
 *
 * Hiding a section is a theme-template decision rather than page content, so it
 * cannot live in a page's `lect`; and the theme bundle is a read-only asset
 * subtree that `npm run theme:sync` regenerates from the theme repository, so
 * the template file cannot be written back either. This is the writable layer
 * between the two — a buffer of pending edits that `publish` folds into the
 * theme and then empties.
 *
 * A copy of `order` is stored only after someone deliberately rearranges or
 * adds sections. At render/publish time, newly authored theme keys that are not
 * in that snapshot are appended, so a later theme update is not lost.
 *
 * The record lives on the CMS that owns it (plugin state), not in this
 * Worker's KV. One plugin Worker serves many hosts, so a copy kept here would
 * outlive the host it describes and stay invisible to its admins — and D1's
 * strong consistency is what a read-modify-write like this needs, which KV's
 * eventual consistency could not give it.
 */
export interface TemplateOverrides {
  /** Section keys dropped from the template's compiled `order`. */
  hidden: string[];
  /** Per section key, the Liquid each declared setting binds to. */
  settings: Record<string, Record<string, string>>;
  /** Explicit order chosen in the editor; newly authored theme keys are merged in. */
  order: string[];
  /** Sections created in the editor before they are published into the template. */
  added: Record<string, { type: string }>;
}

/** Every template's overrides for one theme — what a single state key holds. */
export type ThemeOverrides = Record<string, TemplateOverrides>;

/**
 * One key per theme rather than per template: it makes reading them all a
 * point read instead of a scan, keeps a read-modify-write to a single row, and
 * bounds the key count by the number of themes rather than themes × templates.
 */
function stateKey(themeId: string): string {
  return `theme.overrides.${themeId}`;
}

/** Pre-migration KV key: `sections:<tenant ref>:<theme>:<template>`. */
function legacyKey(env: PluginEnv, themeId: string, templateId: string): string {
  const ref = env.CMS_TENANT_REF?.trim() ?? '';
  return ref ? `sections:${ref}:${themeId}:${templateId}` : '';
}

export class MissingOverrideStoreError extends Error {
  constructor() {
    super('Theme editor changes are stored on this CMS, which could not be reached.');
    this.name = 'MissingOverrideStoreError';
  }
}

/**
 * Raised when the request carries no CMS connection to store against. Distinct
 * from an unreachable store because the fix is different: this one means the
 * plugin is not connected to the host at all.
 */
export class UnknownTenantError extends Error {
  constructor() {
    super('This request could not be attributed to a connected CMS, so its '
      + 'theme overrides cannot be read or written.');
    this.name = 'UnknownTenantError';
  }
}

/**
 * Overrides are read right after they are written and must never be served
 * stale, so nothing is cached: a Hide toggle handled by one isolate has to be
 * visible to the next request whichever isolate takes it.
 */
function store(env: PluginEnv) {
  return pluginState(env, PLUGIN_ID, { ttlMs: 0 });
}

/**
 * Visible-by-default: an unreachable store must not blank out a preview, so
 * reads degrade to "nothing hidden" while writes fail loudly. This only
 * affects the editor's own preview — the public site renders from the
 * published theme files, not from this layer.
 */
async function readTheme(env: PluginEnv, themeId: string): Promise<ThemeOverrides> {
  try {
    return parseThemeOverrides(await store(env).get<unknown>(stateKey(themeId)));
  } catch (error) {
    console.warn(`Could not read theme overrides for ${themeId}:`, error);
    return {};
  }
}

async function writeTheme(env: PluginEnv, themeId: string, value: ThemeOverrides): Promise<void> {
  const state = writableStore(env);
  // A template entry that hides nothing, rebinds nothing, and changes no
  // structure says nothing, so
  // it is not stored — otherwise clearing the last real override would leave
  // the theme with a record that only looks like it has pending edits.
  const pruned = Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => hasTemplateOverrides(entry))
    .map(([templateId, entry]) => [templateId, {
      hidden: entry.hidden,
      settings: entry.settings,
      ...(entry.order.length > 0 ? { order: entry.order } : {}),
      ...(Object.keys(entry.added).length > 0 ? { added: entry.added } : {}),
    }]));
  try {
    // An empty record is the absence of overrides, not an override to nothing —
    // and dropping the key keeps a tenant well inside the per-plugin key cap.
    if (Object.keys(pruned).length === 0) await state.delete(stateKey(themeId));
    else await state.put(stateKey(themeId), pruned);
  } catch (error) {
    // A store that cannot take the write is reported as such, so the editor
    // says the change did not land rather than failing as an unhandled error.
    console.warn(`Could not store theme overrides for ${themeId}:`, error);
    throw new MissingOverrideStoreError();
  }
}

/** The store a write must use, or the reason there is not one. */
function writableStore(env: PluginEnv) {
  try {
    return store(env);
  } catch (error) {
    if (error instanceof CmsNotConfiguredError) throw new UnknownTenantError();
    throw error;
  }
}

/**
 * Adopts anything still in the pre-migration KV namespace for the given
 * templates, so installs predating the move keep their pending edits. Migrated
 * entries are written to the host and dropped from KV, which drains the
 * namespace as themes are opened; it can be unbound once empty.
 */
async function adoptLegacy(
  env: PluginEnv,
  themeId: string,
  record: ThemeOverrides,
  templateIds: string[],
): Promise<ThemeOverrides> {
  if (!env.THEME_OVERRIDES) return record;
  const pending = templateIds.filter((templateId) => !(templateId in record));
  if (pending.length === 0) return record;

  const adopted: ThemeOverrides = { ...record };
  const migrated: string[] = [];
  for (const templateId of pending) {
    const key = legacyKey(env, themeId, templateId);
    if (!key) continue;
    const raw = await env.THEME_OVERRIDES.get(key).catch(() => null);
    const parsed = parseOverrides(raw);
    if (!hasTemplateOverrides(parsed)) continue;
    adopted[templateId] = parsed;
    migrated.push(key);
  }
  if (migrated.length === 0) return record;

  // Only once the host has taken them: a failed write leaves the edits where
  // they are rather than losing them between the two stores.
  try {
    await writeTheme(env, themeId, adopted);
  } catch (error) {
    console.warn(`Could not migrate theme overrides for ${themeId} to the CMS:`, error);
    return adopted;
  }
  for (const key of migrated) await env.THEME_OVERRIDES.delete(key).catch(() => {});
  return adopted;
}

export async function templateOverrides(
  env: PluginEnv,
  themeId: string,
  templateId: string,
): Promise<TemplateOverrides> {
  const record = await adoptLegacy(env, themeId, await readTheme(env, themeId), [templateId]);
  return record[templateId] ?? emptyOverrides();
}

export async function hiddenSections(
  env: PluginEnv,
  themeId: string,
  templateId: string,
): Promise<Set<string>> {
  return new Set((await templateOverrides(env, themeId, templateId)).hidden);
}

/**
 * Every template's overrides, for tooling that writes them into the theme.
 * One read for the whole theme, and templates the theme no longer declares are
 * left out — the theme, not this layer, decides what templates exist.
 */
export async function allTemplateOverrides(
  env: PluginEnv,
  themeId: string,
  templateIds: string[],
): Promise<ThemeOverrides> {
  const record = await adoptLegacy(env, themeId, await readTheme(env, themeId), templateIds);
  const declared = new Set(templateIds);
  return Object.fromEntries(Object.entries(record).filter(([templateId, value]) =>
    declared.has(templateId)
    && hasTemplateOverrides(value)));
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
  const record = await readTheme(env, themeId);
  if (!(templateId in record)) return;
  delete record[templateId];
  await writeTheme(env, themeId, record);
}

/**
 * Drops every override belonging to a theme, for when the theme itself goes.
 *
 * Overrides are keyed by theme id, so leaving them behind would mean a theme
 * later cloned under the same id silently inheriting the deleted one's hidden
 * sections and rebound settings.
 */
export async function clearThemeOverrides(env: PluginEnv, themeId: string): Promise<number> {
  const record = await readTheme(env, themeId);
  const templates = Object.keys(record).length;
  await writeTheme(env, themeId, {});
  return templates;
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
  const record = await adoptLegacy(env, themeId, await readTheme(env, themeId), [templateId]);
  const current = record[templateId] ?? emptyOverrides();
  const next: TemplateOverrides = {
    ...current,
    settings: { ...current.settings, [sectionKey]: settings },
  };
  // An empty map is the absence of an override, not an override to nothing.
  if (Object.keys(settings).length === 0) delete next.settings[sectionKey];
  await writeTheme(env, themeId, withTemplate(record, templateId, next));
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
  const record = await adoptLegacy(env, themeId, await readTheme(env, themeId), [templateId]);
  const current = record[templateId] ?? emptyOverrides();
  const keys = new Set(current.hidden);
  if (hidden) keys.add(section);
  else keys.delete(section);
  const stored = [...keys].sort();
  await writeTheme(env, themeId, withTemplate(record, templateId, { ...current, hidden: stored }));
  return stored;
}

/** Stores the effective JSON template order selected in the sidebar. */
export async function setSectionOrder(
  env: PluginEnv,
  themeId: string,
  templateId: string,
  order: string[],
): Promise<TemplateOverrides> {
  const record = await adoptLegacy(env, themeId, await readTheme(env, themeId), [templateId]);
  const current = record[templateId] ?? emptyOverrides();
  const next = { ...current, order: [...order] };
  await writeTheme(env, themeId, withTemplate(record, templateId, next));
  return next;
}

/** Adds a section declaration and appends its generated key to the order. */
export async function addTemplateSection(
  env: PluginEnv,
  themeId: string,
  templateId: string,
  key: string,
  type: string,
  order: string[],
): Promise<TemplateOverrides> {
  const record = await adoptLegacy(env, themeId, await readTheme(env, themeId), [templateId]);
  const current = record[templateId] ?? emptyOverrides();
  const next: TemplateOverrides = {
    ...current,
    order: [...order, key],
    added: { ...current.added, [key]: { type } },
  };
  await writeTheme(env, themeId, withTemplate(record, templateId, next));
  return next;
}

/** Sets a template's entry, or removes it once it says nothing. */
function withTemplate(
  record: ThemeOverrides,
  templateId: string,
  value: TemplateOverrides,
): ThemeOverrides {
  const next = { ...record };
  if (!hasTemplateOverrides(value)) delete next[templateId];
  else next[templateId] = value;
  return next;
}

function parseThemeOverrides(stored: unknown): ThemeOverrides {
  if (!isRecord(stored)) return {};
  const record: ThemeOverrides = {};
  for (const [templateId, value] of Object.entries(stored)) {
    if (!isRecord(value)) continue;
    record[templateId] = parseOverrides(value);
  }
  return record;
}

/** Accepts the stored shape, or the JSON text the legacy KV namespace holds. */
function parseOverrides(stored: string | Record<string, unknown> | null): TemplateOverrides {
  const empty = emptyOverrides();
  if (!stored) return empty;
  let parsed: unknown = stored;
  if (typeof stored === 'string') {
    try {
      parsed = JSON.parse(stored);
    } catch {
      return empty;
    }
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
  const added: Record<string, { type: string }> = {};
  if (isRecord(parsed.added)) {
    for (const [key, section] of Object.entries(parsed.added)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(key) || !isRecord(section)) continue;
      const type = typeof section.type === 'string' ? section.type : '';
      if (/^[a-z0-9][a-z0-9-]*$/.test(type)) added[key] = { type };
    }
  }
  return {
    hidden: Array.isArray(parsed.hidden)
      ? parsed.hidden.filter((key): key is string => typeof key === 'string')
      : [],
    settings,
    order: Array.isArray(parsed.order)
      ? parsed.order.filter((key): key is string => typeof key === 'string')
      : [],
    added,
  };
}

function emptyOverrides(): TemplateOverrides {
  return { hidden: [], settings: {}, order: [], added: {} };
}

function hasTemplateOverrides(value: TemplateOverrides): boolean {
  return value.hidden.length > 0
    || Object.keys(value.settings).length > 0
    || value.order.length > 0
    || Object.keys(value.added).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
