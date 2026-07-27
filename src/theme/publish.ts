import type { TemplateOverrides } from './overrides';

/**
 * Folds the editor's override layer into a template's own JSON. This is the
 * same merge `theme:apply` performs on a checked-out theme, kept here so a
 * bucket-backed theme can be published by the Worker itself.
 */
export function applyOverridesToTemplate(
  template: unknown,
  overrides: TemplateOverrides,
): { next: Record<string, unknown>; changes: string[] } {
  const next = structuredClone(isRecord(template) ? template : {});
  const changes: string[] = [];

  const hidden = new Set(overrides.hidden);
  if (hidden.size && Array.isArray(next.order)) {
    const kept = next.order.filter((key) => typeof key !== 'string' || !hidden.has(key));
    if (kept.length !== next.order.length) {
      changes.push(`order: removed ${[...hidden].join(', ')}`);
      next.order = kept;
    }
  }

  const sections = isRecord(next.sections) ? next.sections : {};
  for (const [sectionKey, settings] of Object.entries(overrides.settings)) {
    const section = sections[sectionKey];
    // A section the template no longer declares is skipped rather than
    // recreated: the theme, not the override, decides what sections exist.
    if (!isRecord(section)) continue;
    const declared = isRecord(section.settings) ? { ...section.settings } : {};
    for (const [id, binding] of Object.entries(settings)) {
      if (declared[id] === binding) continue;
      changes.push(`${sectionKey}.${id}: ${String(declared[id] ?? '(unset)')} → ${binding}`);
      declared[id] = binding;
    }
    section.settings = declared;
  }

  return { next, changes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
