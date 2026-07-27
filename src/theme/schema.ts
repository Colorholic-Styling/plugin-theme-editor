import type { ThemeStore } from './store';

/**
 * Section schemas, read from the theme the way Shopify reads them: the
 * `{% schema %}` tag in `sections/<type>.liquid` is the section's own
 * description of its settings, so labels, control types, and option lists come
 * from the theme author instead of being guessed from whatever a value happens
 * to look like.
 */
export interface SchemaOption {
  value: string;
  label: string;
}

export interface SchemaSetting {
  id: string;
  type: string;
  label: string;
  options: SchemaOption[];
  default: string;
}

export interface SectionSchema {
  name: string;
  settings: SchemaSetting[];
}

const SCHEMA_TAG = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/;

export function parseSectionSchema(source: string): SectionSchema | null {
  const body = SCHEMA_TAG.exec(source)?.[1];
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const settings = Array.isArray(parsed.settings) ? parsed.settings : [];
  return {
    name: stringValue(parsed.name),
    settings: settings.filter(isRecord).flatMap((setting): SchemaSetting[] => {
      const id = stringValue(setting.id);
      if (!id) return [];
      return [{
        id,
        type: stringValue(setting.type) || 'text',
        label: stringValue(setting.label) || id,
        options: (Array.isArray(setting.options) ? setting.options : [])
          .filter(isRecord)
          .map((option) => ({
            value: stringValue(option.value),
            label: stringValue(option.label) || stringValue(option.value),
          })),
        default: setting.default === undefined || setting.default === null
          ? ''
          : String(setting.default),
      }];
    }),
  };
}

/** A block type with no section file, or no schema in it, simply has none. */
export async function sectionSchema(
  store: ThemeStore,
  type: string,
): Promise<SectionSchema | null> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(type)) return null;
  try {
    return parseSectionSchema(await store.read(`/sections/${type}.liquid`));
  } catch {
    return null;
  }
}

/**
 * The Liquid a JSON template uses to bind this setting to the block, which is
 * the expression the theme author has to write in `templates/*.json`.
 */
export function settingBinding(blockIndex: number, id: string): string {
  return `{{ page.blocks[${blockIndex}].${id} }}`;
}

/**
 * Schema ids name the *view model* the section renders, while the editor writes
 * `lect`. The theme's naming is regular enough to bridge the two — `bodyHtml`
 * reads `body`, `pictureAlt` reads `picture_alt`, `primary_label` reads
 * `primary.label` — so candidates are matched against the paths the editor
 * actually derived rather than assumed to exist.
 */
export function settingPathCandidates(id: string): string[] {
  const bases = new Set<string>([id]);
  if (/Html$/.test(id)) bases.add(id.slice(0, -'Html'.length));
  for (const base of [...bases]) bases.add(snakeCase(base));

  const candidates = new Set<string>();
  for (const base of bases) {
    candidates.add(base);
    const separator = base.indexOf('_');
    if (separator > 0) {
      candidates.add(`${base.slice(0, separator)}/${base.slice(separator + 1)}`);
    }
  }
  return [...candidates];
}

export interface SchemaField {
  id: string;
  label: string;
  type: string;
  /** The Liquid the template binds, which is what this panel edits. */
  binding: string;
  /** True when the binding came from an override rather than the theme file. */
  overridden: boolean;
  /** Input name for saving the binding back into the template. */
  inputName: string;
  options: Array<SchemaOption & { selected: boolean }>;
  hasOptions: boolean;
  path: string;
  /** What the binding currently resolves to, shown as context. */
  value: string;
  defaultValue: string;
  multiline: boolean;
  /** False when nothing in `lect` backs this setting, so it has no value yet. */
  editable: boolean;
}

/**
 * Joins a section's declared settings to the block's own editable values. A
 * setting the theme declares but the page has no value for still appears, since
 * the schema — not the stored data — is what says the section takes it.
 */
export function schemaFields(
  schema: SectionSchema,
  fields: Array<{ inputName: string; path: string; value: string; multiline: boolean; readOnly: boolean }>,
  blockIndex: number,
  language: string,
  declared: Readonly<Record<string, unknown>> = {},
  overridden: Readonly<Record<string, string>> = {},
): SchemaField[] {
  const prefix = `/_blocks/${blockIndex}/`;
  const byPath = new Map(fields.map((field) => [field.path, field]));

  return schema.settings.map((setting): SchemaField => {
    const match = settingPathCandidates(setting.id)
      .flatMap((candidate) => [`${prefix}${candidate}/${language}`, `${prefix}${candidate}`])
      .map((path) => byPath.get(path))
      .find((field) => field !== undefined);

    // What the template binds today: an override if one was saved, otherwise
    // what the theme's own template declares, otherwise the obvious binding for
    // a setting the template has not wired up yet.
    const fromTheme = typeof declared[setting.id] === 'string' ? declared[setting.id] as string : '';
    const binding = overridden[setting.id] ?? fromTheme ?? '';

    return {
      id: setting.id,
      label: setting.label,
      type: setting.type,
      binding: binding || settingBinding(blockIndex, setting.id),
      overridden: setting.id in overridden,
      inputName: `setting:${setting.id}`,
      options: setting.options.map((option) => ({
        ...option,
        selected: option.value === (match?.value ?? setting.default),
      })),
      hasOptions: setting.options.length > 0,
      path: match?.path ?? '',
      value: match?.value ?? '',
      defaultValue: setting.default,
      multiline: setting.type === 'richtext' || setting.type === 'textarea' || (match?.multiline ?? false),
      editable: Boolean(match) && !(match?.readOnly ?? false),
    };
  });
}

function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
