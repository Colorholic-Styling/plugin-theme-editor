import type { PluginEnv } from '../types';
import type { ThemeDefinition } from '../themes';
import { AssetThemeStore } from './store';

export interface ThemeTemplate {
  id: string;
  label: string;
  path: string;
  format: 'json' | 'liquid';
}

export async function themeTemplates(
  env: PluginEnv,
  theme: ThemeDefinition,
): Promise<ThemeTemplate[]> {
  const store = new AssetThemeStore(env.VIEWS, theme.assetPrefix);
  const manifest = JSON.parse(await store.read('/theme-manifest.json')) as unknown;
  if (!isRecord(manifest) || !Array.isArray(manifest.templates)) return [];

  return manifest.templates
    .filter(isRecord)
    .map((entry): ThemeTemplate | null => {
      const id = stringValue(entry.id);
      const label = stringValue(entry.label);
      const path = stringValue(entry.path);
      const format = entry.format === 'json' || entry.format === 'liquid'
        ? entry.format
        : null;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)
        || !/^\/templates\/[a-z0-9][a-z0-9-]*\.(json|liquid)$/.test(path)
        || !path.endsWith(`.${format}`)
        || !format) return null;
      return { id, label: label || humanize(id), path, format };
    })
    .filter((template): template is ThemeTemplate => template !== null);
}

export interface TemplateSection {
  key: string;
  type: string;
  label: string;
  blockIndex: number | null;
}

/**
 * The template's declared sections in its own `order`, including any currently
 * hidden — the editor has to keep listing a hidden section to offer showing it
 * again. Liquid templates declare no sections, so they have none to toggle.
 */
export async function templateSections(
  env: PluginEnv,
  theme: ThemeDefinition,
  template: ThemeTemplate,
): Promise<TemplateSection[]> {
  if (template.format !== 'json') return [];
  const store = new AssetThemeStore(env.VIEWS, theme.assetPrefix);
  let definition: unknown;
  try {
    definition = JSON.parse(await store.read(template.path));
  } catch {
    return [];
  }
  if (!isRecord(definition)) return [];
  const sections = isRecord(definition.sections) ? definition.sections : {};
  const order = Array.isArray(definition.order) ? definition.order : [];

  return order.flatMap((key): TemplateSection[] => {
    if (typeof key !== 'string') return [];
    const section = sections[key];
    if (!isRecord(section)) return [];
    return [{
      key,
      type: stringValue(section.type) || (section.source === 'blocks' ? 'blocks' : ''),
      label: humanize(key),
      blockIndex: referencedBlockIndex(section),
    }];
  });
}

/**
 * A JSON template binds a declared section to a CMS block by interpolating
 * `page.blocks[N]` into its settings, so that reference is the only link back
 * to the editable block. A section reading no block — a page header — or
 * mixing several has no single block to speak for.
 */
export function referencedBlockIndex(section: Record<string, unknown>): number | null {
  const referenced = new Set<number>();
  for (const [, index] of JSON.stringify(section).matchAll(/page\.blocks\[(\d+)\]/g)) {
    referenced.add(Number(index));
  }
  const [only] = referenced;
  return referenced.size === 1 ? only : null;
}

export function selectThemeTemplate(
  templates: ThemeTemplate[],
  requestedId: string | null,
  pageType = '',
): ThemeTemplate | null {
  if (requestedId) {
    return templates.find((template) => template.id === requestedId) ?? null;
  }
  const preferred = pageType === 'news'
    ? 'news-article'
    : pageType === 'news-index' ? 'news-index' : 'page';
  return templates.find((template) => template.id === preferred)
    ?? templates[0]
    ?? null;
}

function humanize(value: string): string {
  return value.split('-').map((part) => part
    ? part[0].toUpperCase() + part.slice(1)
    : '').join(' ');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
