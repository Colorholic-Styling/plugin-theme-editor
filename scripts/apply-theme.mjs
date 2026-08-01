// ============================================================
// Writes the editor's override layer into the theme's own template files.
//
// The plugin is a Worker: it has no filesystem, so it can never edit the theme
// it renders. It keeps edits in KV instead, and this — running on the machine
// that does have the theme checked out — is what makes them permanent.
//
//   npm run theme:apply              # write the theme, then clear what applied
//   npm run theme:apply -- --dry-run # show the diff and change nothing
// ============================================================

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const configuredSource = process.env.THEME_SOURCE_DIR?.trim();
if (!configuredSource) {
  throw new Error('THEME_SOURCE_DIR is required. Point it at the theme views directory to update.');
}
const source = resolve(configuredSource);
const pluginUrl = (process.env.PLUGIN_URL || 'http://localhost:8798').replace(/\/+$/, '');
const themeId = process.env.THEME_ID || 'development';
const dryRun = process.argv.includes('--dry-run');

/** The dev secret the plugin authenticates with, as `wrangler dev` reads it. */
async function pluginSecret() {
  if (process.env.PLUGIN_SECRET) return process.env.PLUGIN_SECRET;
  const vars = await readFile(join(projectRoot, '.dev.vars'), 'utf8').catch(() => '');
  const match = /^PLUGIN_SECRET\s*=\s*(.+)$/m.exec(vars);
  if (!match) {
    throw new Error('No PLUGIN_SECRET: set it in .dev.vars or the environment.');
  }
  return match[1].trim().replace(/^["']|["']$/g, '');
}

async function pluginFetch(secret, path, init = {}) {
  const response = await fetch(`${pluginUrl}${path}`, {
    ...init,
    headers: {
      'x-plugin-secret': secret,
      'x-cms-user': JSON.stringify({ id: 'theme-apply', role: 'admin' }),
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${path} responded ${response.status}. Is \`npm run dev\` running on ${pluginUrl}?`);
  }
  return response.json();
}

/**
 * Applies one template's overrides to the theme's own JSON: hidden sections
 * leave `order`, deleted sections leave both `sections` and `order`, and
 * changed bindings replace what the section declares.
 */
function applyOverrides(template, overrides) {
  const next = structuredClone(template);
  const changes = [];

  next.sections = next.sections && typeof next.sections === 'object' ? next.sections : {};
  for (const [sectionKey, section] of Object.entries(overrides.added ?? {})) {
    if (next.sections[sectionKey]) continue;
    next.sections[sectionKey] = { type: section.type };
    changes.push(`sections: added ${sectionKey} (${section.type})`);
  }
  const deleted = new Set(overrides.deleted ?? []);
  for (const sectionKey of deleted) {
    const section = next.sections[sectionKey];
    if (!section || typeof section !== 'object') continue;
    const type = typeof section.type === 'string' ? section.type : 'section';
    delete next.sections[sectionKey];
    changes.push(`sections: removed ${sectionKey} (${type})`);
  }

  if (Array.isArray(overrides.order) && overrides.order.length > 0) {
    const available = new Set(Object.keys(next.sections));
    const sourceOrder = Array.isArray(next.order) ? next.order.filter((key) => typeof key === 'string') : [];
    const seen = new Set();
    const arranged = [...overrides.order, ...sourceOrder].filter((key) => {
      if (!available.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (JSON.stringify(arranged) !== JSON.stringify(sourceOrder)) {
      changes.push(`order: ${sourceOrder.join(', ')} → ${arranged.join(', ')}`);
      next.order = arranged;
    }
  }

  if (deleted.size && Array.isArray(next.order)) {
    const kept = next.order.filter((key) => !deleted.has(key));
    if (kept.length !== next.order.length) {
      changes.push(`order: removed ${[...deleted].join(', ')}`);
      next.order = kept;
    }
  }

  const hidden = new Set(overrides.hidden ?? []);
  if (hidden.size && Array.isArray(next.order)) {
    const kept = next.order.filter((key) => !hidden.has(key));
    if (kept.length !== next.order.length) {
      changes.push(`order: removed ${[...hidden].join(', ')}`);
      next.order = kept;
    }
  }

  for (const [sectionKey, settings] of Object.entries(overrides.settings ?? {})) {
    const section = next.sections?.[sectionKey];
    if (!section) continue;
    section.settings = { ...section.settings };
    for (const [id, binding] of Object.entries(settings)) {
      if (section.settings[id] === binding) continue;
      changes.push(`${sectionKey}.${id}: ${section.settings[id] ?? '(unset)'} → ${binding}`);
      section.settings[id] = binding;
    }
  }

  return { next, changes };
}

const secret = await pluginSecret();
const { templates } = await pluginFetch(secret, `/__plugin/admin/overrides?theme=${encodeURIComponent(themeId)}`);
const entries = Object.entries(templates ?? {});

if (entries.length === 0) {
  process.stdout.write('No editor overrides to apply.\n');
  process.exit(0);
}

let written = 0;
for (const [templateId, overrides] of entries) {
  const file = join(source, 'templates', `${templateId}.json`);
  const original = await readFile(file, 'utf8').catch(() => null);
  if (original === null) {
    process.stderr.write(`Skipped ${templateId}: ${file} does not exist\n`);
    continue;
  }

  const { next, changes } = applyOverrides(JSON.parse(original), overrides);
  if (changes.length === 0) {
    process.stdout.write(`${templateId}: already matches the theme\n`);
    continue;
  }

  process.stdout.write(`${templateId}:\n${changes.map((line) => `  ${line}\n`).join('')}`);
  if (dryRun) continue;

  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  written += 1;
  // Cleared only after the write succeeded, so a failure here leaves the edit
  // in the editor rather than losing it between the two.
  await pluginFetch(secret, `/__plugin/admin/overrides/clear?theme=${encodeURIComponent(themeId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ template: templateId }),
  });
}

process.stdout.write(dryRun
  ? '\nDry run: nothing written.\n'
  : `\nWrote ${written} template${written === 1 ? '' : 's'} into ${source}/templates\n`);
