export type Lect = Record<string, unknown>;

export function attr(lect: Lect, key: string): string {
  return scalar(lect[key]);
}

export function localized(lect: Lect, key: string, chain: readonly string[]): string {
  const value = lect[key];
  if (value == null) return '';
  if (isRecord(value)) {
    for (const language of chain) {
      const found = scalar(value[language]);
      if (found) return found;
    }
    for (const candidate of Object.values(value)) {
      const found = scalar(candidate);
      if (found) return found;
    }
    return '';
  }
  return scalar(value);
}

export function text(lect: Lect, key: string, chain: readonly string[]): string {
  return localized(lect, key, chain) || attr(lect, key);
}

export function items(lect: Lect, key: string): Lect[] {
  const value = lect[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord)
    .map((row, index) => ({ row, index, weight: Number(row._weight ?? index) }))
    .sort((left, right) =>
      (Number.isFinite(left.weight) ? left.weight : left.index)
        - (Number.isFinite(right.weight) ? right.weight : right.index)
        || left.index - right.index)
    .map(({ row }) => row);
}

export function indexedBlocks(lect: Lect): Array<{ block: Lect; index: number }> {
  const value = lect._blocks;
  if (!Array.isArray(value)) return [];
  return value
    .map((block, index) => ({ block, index }))
    .filter((entry): entry is { block: Lect; index: number } => isRecord(entry.block))
    .sort((left, right) => {
      const leftWeight = Number(left.block._weight ?? left.index);
      const rightWeight = Number(right.block._weight ?? right.index);
      return (Number.isFinite(leftWeight) ? leftWeight : left.index)
        - (Number.isFinite(rightWeight) ? rightWeight : right.index)
        || left.index - right.index;
    });
}

export function truthy(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function scalar(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isRecord(value)) {
    for (const key of ['url', 'src', 'href', 'path', 'file', 'value']) {
      const found = scalar(value[key]);
      if (found) return found;
    }
    for (const candidate of Object.values(value)) {
      const found = scalar(candidate);
      if (found) return found;
    }
  }
  return '';
}

function isRecord(value: unknown): value is Lect {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

