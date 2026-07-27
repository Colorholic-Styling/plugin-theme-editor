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
const defaultSource = '/Users/colin/Documents/code/projects/colorholicstyling/www/views';
const source = resolve(process.env.THEME_SOURCE_DIR || defaultSource);
const pluginUrl = (process.env.PLUGIN_URL || 'http://localhost:8798').replace(/\/+$/, '');
const themeId = process.env.THEME_ID || 'colorholic-styling';
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
 * leave `order`, and changed bindings replace what the section declares.
 * The section definitions themselves are kept, so showing one again is a
 * matter of putting its key back rather than rebuilding it.
 */
function applyOverrides(template, overrides) {
  const next = structuredClone(template);
  const changes = [];

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
