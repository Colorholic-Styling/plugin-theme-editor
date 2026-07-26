import type { CmsPage } from '@lionrockjs/worker-cms-plugin';

export interface EditorField {
  inputName: string;
  label: string;
  path: string;
  value: string;
  kind: 'attribute' | 'localized' | 'pointer' | 'structure';
  badge: string;
  multiline: boolean;
  readOnly: boolean;
  group: string;
}

export interface BlockChoice {
  index: number;
  type: string;
  label: string;
  selected: boolean;
  href: string;
}

const READ_ONLY_KEYS = new Set(['_id', '_type', '_weight']);
const MULTILINE_KEY = /(body|description|summary|content|html|markdown|note|address|hours|bio|quote|answer)$/i;

export function editorFields(
  page: CmsPage,
  languages: string[],
  language: string,
  blockIndex: number | null,
): EditorField[] {
  const lect = page.lect ?? {};
  const source = blockIndex === null ? lect : blockAt(lect, blockIndex);
  if (!source) return [];

  const fields: EditorField[] = [];
  const basePath: Array<string | number> = blockIndex === null ? [] : ['_blocks', blockIndex];
  flattenRecord(source, {
    fields,
    path: basePath,
    languages: new Set([...languages, 'mis']),
    language,
    group: blockIndex === null ? 'Page values' : 'Block settings',
    skipBlocks: blockIndex === null,
  });
  return fields;
}

export function blockChoices(
  page: CmsPage,
  selectedBlock: number | null,
  editorBase: string,
  language: string,
): BlockChoice[] {
  const blocks = rawBlocks(page.lect);
  return blocks
    .map((block, index) => ({ block, index }))
    .sort((left, right) =>
      numericWeight(left.block._weight, left.index) - numericWeight(right.block._weight, right.index)
        || left.index - right.index)
    .map(({ block, index }) => {
      const type = scalar(block._type) || 'block';
      const title = localizedValue(block.title, language)
        || localizedValue(block.eyebrow, language)
        || humanize(type);
      const href = `${editorBase}?page_id=${page.id}&language=${encodeURIComponent(language)}&block=${index}`;
      return {
        index,
        type,
        label: title,
        selected: selectedBlock === index,
        href,
      };
    });
}

export function applyEditorFields(
  original: Record<string, unknown>,
  form: FormData,
): Record<string, unknown> {
  const lect = structuredClone(original);
  for (const [name, rawValue] of form.entries()) {
    if (!name.startsWith('field:/') || typeof rawValue !== 'string') continue;
    const path = decodePath(name.slice('field:'.length));
    if (!path.length || path.some((segment) => segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) {
      continue;
    }
    if (READ_ONLY_KEYS.has(String(path[path.length - 1]))) continue;
    setExistingScalar(lect, path, rawValue);
  }
  return lect;
}

export function selectedBlockFrom(url: URL, page: CmsPage | null): number | null {
  const raw = url.searchParams.get('block');
  if (raw === null || raw === '') return null;
  const index = Number.parseInt(raw, 10);
  if (!Number.isInteger(index) || index < 0 || !page || !blockAt(page.lect, index)) return null;
  return index;
}

function flattenRecord(
  record: Record<string, unknown>,
  state: {
    fields: EditorField[];
    path: Array<string | number>;
    languages: Set<string>;
    language: string;
    group: string;
    skipBlocks: boolean;
  },
): void {
  for (const [key, value] of Object.entries(record)) {
    if (state.skipBlocks && key === '_blocks') continue;
    const path = [...state.path, key];

    if (isLanguageMap(value, state.languages)) {
      const localized = value as Record<string, unknown>;
      const selectedLanguage = state.language || [...state.languages][0] || 'mis';
      pushField(state.fields, {
        path: [...path, selectedLanguage],
        key,
        value: localized[selectedLanguage],
        kind: 'localized',
        badge: selectedLanguage,
        group: state.group,
        readOnly: false,
      });
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (!isRecord(item)) return;
        flattenRecord(item, {
          ...state,
          path: [...path, index],
          group: `${humanize(key)} · item ${index + 1}`,
          skipBlocks: false,
        });
      });
      continue;
    }

    if (isRecord(value)) {
      flattenRecord(value, {
        ...state,
        path,
        group: key === '_pointers' ? 'Page pointers' : humanize(key),
        skipBlocks: false,
      });
      continue;
    }

    pushField(state.fields, {
      path,
      key,
      value,
      kind: key.startsWith('_') ? 'structure' : state.path.at(-1) === '_pointers' ? 'pointer' : 'attribute',
      badge: key.startsWith('_') ? 'system' : state.path.at(-1) === '_pointers' ? 'pointer' : 'attribute',
      group: state.group,
      readOnly: READ_ONLY_KEYS.has(key),
    });
  }
}

function pushField(
  fields: EditorField[],
  input: {
    path: Array<string | number>;
    key: string;
    value: unknown;
    kind: EditorField['kind'];
    badge: string;
    group: string;
    readOnly: boolean;
  },
): void {
  const path = `/${input.path.map((segment) => encodeURIComponent(String(segment))).join('/')}`;
  const value = scalar(input.value);
  fields.push({
    inputName: `field:${path}`,
    label: humanize(input.key),
    path,
    value,
    kind: input.kind,
    badge: input.badge,
    multiline: MULTILINE_KEY.test(input.key) || value.length > 120 || /<[^>]+>/.test(value),
    readOnly: input.readOnly,
    group: input.group,
  });
}

function decodePath(value: string): Array<string | number> {
  return value
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
    .map((segment) => /^\d+$/.test(segment) ? Number.parseInt(segment, 10) : segment);
}

function setExistingScalar(
  root: Record<string, unknown>,
  path: Array<string | number>,
  value: string,
): void {
  let cursor: unknown = root;
  for (let index = 0; index < path.length - 1; index++) {
    const segment = path[index];
    if (typeof segment === 'number') {
      if (!Array.isArray(cursor) || segment < 0 || segment >= cursor.length) return;
      cursor = cursor[segment];
    } else {
      if (!isRecord(cursor) || !Object.hasOwn(cursor, segment)) return;
      cursor = cursor[segment];
    }
  }

  const leaf = path[path.length - 1];
  if (typeof leaf === 'number') return;
  if (!isRecord(cursor) || !Object.hasOwn(cursor, leaf)) return;
  const existing = cursor[leaf];
  if (existing !== null && typeof existing === 'object') return;
  cursor[leaf] = coerceScalar(existing, value);
}

function coerceScalar(existing: unknown, value: string): string | number | boolean | null {
  if (typeof existing === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : existing;
  }
  if (typeof existing === 'boolean') return value === 'true' || value === '1' || value === 'on';
  if (existing === null && value === '') return null;
  return value;
}

function rawBlocks(lect: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(lect._blocks) ? lect._blocks.filter(isRecord) : [];
}

function blockAt(lect: Record<string, unknown>, index: number): Record<string, unknown> | null {
  const value = Array.isArray(lect._blocks) ? lect._blocks[index] : null;
  return isRecord(value) ? value : null;
}

function isLanguageMap(value: unknown, languages: Set<string>): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0
    && entries.every(([key, entry]) =>
      (languages.has(key) || /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(key))
        && (entry === null || ['string', 'number', 'boolean'].includes(typeof entry)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numericWeight(value: unknown, fallback: number): number {
  const weight = Number(value);
  return Number.isFinite(weight) ? weight : fallback;
}

function localizedValue(value: unknown, language: string): string {
  if (!isRecord(value)) return scalar(value);
  return scalar(value[language]) || scalar(value.mis) || scalar(Object.values(value)[0]);
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function humanize(value: string): string {
  const label = value
    .replace(/^_+/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  return label ? `${label[0].toUpperCase()}${label.slice(1)}` : 'Value';
}

