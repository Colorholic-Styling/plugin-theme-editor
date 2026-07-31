// ============================================================
// One-off: move unprefixed theme folders under their owning tenant.
//
// Themes used to be keyed `<theme-id>/<path>`, with the bucket root acting as
// the registry. One bucket serves every connected CMS, so that layout let any
// tenant list — and, by cloning a repository of the same name, overwrite —
// another tenant's theme. Keys are now `t/<tenant-ref>/<theme-id>/<path>`.
//
// This script copies each named theme into a tenant's prefix. R2 has no bulk
// move, so every object is read and re-written; themes are small, so that is
// fine. Nothing is deleted: verify the themes still load in the editor, then
// remove the originals yourself (see the printed command).
//
// The mapping cannot be inferred — the old keys carry no tenant — so it is
// given explicitly:
//
//   node scripts/migrate-theme-prefix.mjs \
//     --bucket=cms-themes \
//     --tenant=https://cms1.example.com --themes=portfolio,studio-minimal
//
// Repeat --tenant/--themes pairs to place different folders with different
// hosts. Add --remote to act on the deployed bucket instead of the local one,
// and --dry-run to print the copies without making them.
//
// The env-fallback tenant (a single CMS configured through CMS_URL and
// PLUGIN_SECRET rather than the TENANTS registry) keeps the unprefixed layout
// and needs no migration.
// ============================================================

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const remote = args.includes('--remote');
const bucket = valueOf('--bucket') || 'cms-themes';

/** First 16 hex chars of SHA-256(origin) — the same ref the Worker derives. */
async function tenantRef(origin) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(origin));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function valueOf(flag) {
  const found = args.find((arg) => arg.startsWith(`${flag}=`));
  return found ? found.slice(flag.length + 1).trim() : '';
}

/** Reads repeated --tenant/--themes pairs in the order they were given. */
function readAssignments() {
  const assignments = [];
  let tenant = '';
  for (const arg of args) {
    if (arg.startsWith('--tenant=')) tenant = arg.slice('--tenant='.length).trim().replace(/\/+$/, '');
    if (!arg.startsWith('--themes=')) continue;
    if (!tenant) throw new Error('--themes must follow a --tenant');
    const themes = arg.slice('--themes='.length).split(',').map((value) => value.trim()).filter(Boolean);
    assignments.push({ tenant, themes });
  }
  return assignments;
}

function wrangler(commandArgs) {
  return execFileSync('npx', ['wrangler', ...commandArgs, remote ? '--remote' : '--local'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** Object keys under a prefix, via `wrangler r2 object list`. */
function listKeys(prefix) {
  const output = wrangler(['r2', 'object', 'list', bucket, `--prefix=${prefix}`]);
  try {
    const parsed = JSON.parse(output);
    return (parsed.objects ?? []).map((object) => object.key);
  } catch {
    throw new Error(`Could not parse the object listing for ${prefix}:\n${output}`);
  }
}

function copyObject(from, to, scratch) {
  const file = join(scratch, 'object.bin');
  wrangler(['r2', 'object', 'get', `${bucket}/${from}`, `--file=${file}`, '--pipe=false']);
  writeFileSync(file, readFileSync(file));
  wrangler(['r2', 'object', 'put', `${bucket}/${to}`, `--file=${file}`]);
}

const assignments = readAssignments();
if (assignments.length === 0) {
  process.stderr.write(
    'Nothing to do. Give at least one --tenant=<cms origin> --themes=<id,id> pair.\n'
    + 'See the header of this file for an example.\n',
  );
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), 'theme-prefix-'));
let copied = 0;
try {
  for (const { tenant, themes } of assignments) {
    const ref = await tenantRef(tenant);
    for (const theme of themes) {
      const keys = listKeys(`${theme}/`);
      if (keys.length === 0) {
        process.stdout.write(`  (nothing under ${theme}/ — already migrated?)\n`);
        continue;
      }
      process.stdout.write(`${tenant} (t/${ref}/) ← ${theme}/ [${keys.length} objects]\n`);
      for (const key of keys) {
        const target = `t/${ref}/${key}`;
        process.stdout.write(`  ${key} → ${target}\n`);
        if (!dryRun) {
          copyObject(key, target, scratch);
          copied += 1;
        }
      }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (dryRun) {
  process.stdout.write('\nDry run: nothing was written.\n');
} else {
  process.stdout.write(
    `\nCopied ${copied} objects. The originals are untouched — confirm each theme still `
    + 'loads in the editor, then delete them:\n'
    + `  npx wrangler r2 object delete ${bucket}/<theme-id>/<path> ${remote ? '--remote' : '--local'}\n`,
  );
}
