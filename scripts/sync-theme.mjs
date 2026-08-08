import { watch } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifestFile = 'theme-manifest.json';
const watchMode = process.argv.includes('--watch');
const pushMode = process.argv.includes('--push');
const pluginUrl = (process.env.PLUGIN_URL || 'http://localhost:8798').replace(/\/+$/, '');
const cmsTenant = process.env.CMS_TENANT?.trim();
const configuredSource = process.env.THEME_SOURCE_DIR?.trim();
const registryPath = resolve(
  projectRoot,
  process.env.THEME_REGISTRY_FILE?.trim() || 'local-themes.json',
);
const themeId = process.env.THEME_ID || 'development';
const THEME_DIRECTORIES = new Set(['assets', 'layout', 'sections', 'snippets', 'templates']);
const THEME_EXTENSION = /\.(liquid|json|css|js|svg|png|jpe?g|webp|ico|woff2?)$/i;
const BINARY_EXTENSION = /\.(png|jpe?g|webp|ico|woff2?)$/i;

// Supplying THEME_SOURCE_DIR is an explicit one-theme compatibility mode. When
// it is omitted, the ignored local-themes.json registry stages every entry at
// once, which lets one Worker preview several checkouts alongside R2 themes.
const registryEntries = configuredSource ? [] : await readRegistry();
const entries = configuredSource
  ? [{ id: themeId, source: resolve(configuredSource), link: process.env.THEME_LINK === '1', legacy: true }]
  : registryEntries;
if (entries.length === 0) {
  throw new Error(
    configuredSource
      ? 'THEME_SOURCE_DIR is required. Point it at the theme views directory to sync.'
      : `No local themes are registered. Run \`npm run theme:add -- --id <id> --source <absolute-path>\` or set THEME_SOURCE_DIR.`,
  );
}
for (const entry of entries) validateEntry(entry);

const singleMode = entries.length === 1 && entries[0].legacy === true;
const legacyDestination = resolve(projectRoot, watchMode ? '.dist/views/theme' : 'views/theme');
const themesRoot = resolve(projectRoot, watchMode ? '.dist/views/themes' : 'views/themes');

/** Sync every configured checkout and return all discovered templates. */
async function syncTheme() {
  if (singleMode) {
    return syncOne(entries[0], legacyDestination);
  }

  await ensureDirectory(themesRoot);
  const wanted = new Set(entries.map((entry) => entry.id));
  for (const entry of await readdir(themesRoot, { withFileTypes: true })) {
    if (!wanted.has(entry.name)) await removeGeneratedEntry(join(themesRoot, entry.name));
  }

  const templates = [];
  const catalog = [];
  for (const entry of entries) {
    const destination = join(themesRoot, entry.id);
    const result = await syncOne(entry, destination);
    templates.push(...result.templates);
    catalog.push({
      id: entry.id,
      name: result.metadata.name || humanize(entry.id),
      ...(result.metadata.description ? { description: result.metadata.description } : {}),
      assetPrefix: `/themes/${entry.id}`,
      source: `Local .dist/views/themes/${entry.id}`,
    });
  }
  await writeFile(
    resolve(projectRoot, watchMode ? '.dist/views/theme-catalog.json' : 'views/theme-catalog.json'),
    `${JSON.stringify({ themes: catalog }, null, 2)}\n`,
    'utf8',
  );
  return templates;
}

async function syncOne(entry, destination) {
  if (entry.link) {
    await linkThemeDirectories(entry.source, destination);
  } else {
    await prepareCopyDestination(destination);
    const sourceFiles = await listThemeFiles(entry.source);
    await copyThemeFiles(entry.source, destination, sourceFiles);
    await pruneRemovedFiles(destination, sourceFiles);
  }
  const metadata = await sourceManifestMetadata(entry.source);
  const templates = await writeManifest(entry.source, destination, metadata);
  return { templates, metadata };
}

/** Remove links left by an earlier link-mode run before writing file copies. */
async function prepareCopyDestination(destination) {
  await ensureDirectory(destination);
  for (const entry of await readdir(destination, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) await unlink(join(destination, entry.name));
  }
}

/**
 * Local development can point the generated theme tree at the checkout rather
 * than copying every file. Keep the generated manifest in the workspace so a
 * source checkout without one is still usable and is never modified here.
 */
async function linkThemeDirectories(source, destination) {
  const sourceInfo = await stat(source).catch(() => null);
  if (!sourceInfo?.isDirectory()) {
    throw new Error(`Theme source directory does not exist: ${source}`);
  }

  const resolvedSource = await realpath(source).catch(() => source);
  const resolvedDestination = resolve(destination);
  if (resolvedSource === resolvedDestination || resolvedSource.startsWith(`${resolvedDestination}${sep}`)) {
    throw new Error('A theme source cannot be the generated theme destination or one of its children.');
  }

  await ensureDirectory(destination);
  for (const directory of THEME_DIRECTORIES) {
    const target = join(source, directory);
    const targetInfo = await stat(target).catch(() => null);
    const linkPath = join(destination, directory);
    if (targetInfo?.isDirectory()) await ensureDirectoryLink(linkPath, target);
    else await removeGeneratedEntry(linkPath);
  }

  // Do not leave files from an earlier copy-mode sync beside the links.
  for (const entry of await readdir(destination, { withFileTypes: true })) {
    if (entry.name === manifestFile || THEME_DIRECTORIES.has(entry.name)) continue;
    await removeGeneratedEntry(join(destination, entry.name));
  }
}

async function ensureDirectory(directory) {
  const existing = await lstat(directory).catch(() => null);
  if (existing?.isSymbolicLink()) await unlink(directory);
  else if (existing && !existing.isDirectory()) await rm(directory, { force: true });
  await mkdir(directory, { recursive: true });
}

async function ensureDirectoryLink(linkPath, target) {
  const existing = await lstat(linkPath).catch(() => null);
  if (existing?.isSymbolicLink()) {
    const currentTarget = await realpath(linkPath).catch(() => '');
    const resolvedTarget = await realpath(target).catch(() => resolve(target));
    if (currentTarget === resolvedTarget) return;
    await unlink(linkPath);
  } else if (existing) {
    await rm(linkPath, { recursive: true, force: true });
  }
  await symlink(target, linkPath, 'dir');
}

async function removeGeneratedEntry(path) {
  const existing = await lstat(path).catch(() => null);
  if (!existing) return;
  if (existing.isSymbolicLink()) await unlink(path);
  else await rm(path, { recursive: true, force: true });
}

async function copyThemeFiles(source, destination, files) {
  for (const file of files) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(source, file)));
  }
}

async function pruneRemovedFiles(destination, sourceFiles) {
  const wanted = new Set(sourceFiles);
  for (const file of await listAllFiles(destination)) {
    // The generated manifest is retained until writeManifest replaces it.
    if (file === manifestFile || wanted.has(file)) continue;
    await rm(join(destination, file), { force: true });
  }
}

async function listAllFiles(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listAllFiles(full, base));
    else files.push(relative(base, full));
  }
  return files;
}

async function listThemeFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    const followed = entry.isSymbolicLink() ? await stat(fullPath).catch(() => null) : entry;
    if (followed?.isFile() && entry.name === manifestFile) {
      files.push(manifestFile);
      continue;
    }
    if (!followed?.isDirectory() || !THEME_DIRECTORIES.has(entry.name)) continue;
    for (const nested of await listAllFiles(fullPath)) {
      const file = join(entry.name, nested).split(sep).join('/');
      if (isThemeSourceFile(file)) files.push(file);
    }
  }
  return files.sort();
}

function isThemeSourceFile(file) {
  if (file === manifestFile) return true;
  const normalized = file.split(sep).join('/');
  const directory = normalized.split('/')[0];
  return THEME_DIRECTORIES.has(directory) && THEME_EXTENSION.test(normalized);
}

async function writeManifest(source, destination, metadata) {
  const themeFiles = await listThemeFiles(destination);
  const templateFiles = themeFiles
    .filter((file) => /^templates\/(?:[a-z0-9][a-z0-9-]*)\.(json|liquid)$/i.test(file));
  const templates = templateFiles.map((file) => {
    const name = file.slice('templates/'.length);
    const extension = file.toLowerCase().endsWith('.json') ? 'json' : 'liquid';
    const id = basename(name, `.${extension}`);
    return {
      id,
      label: humanize(id),
      path: `/${file.split(sep).join('/')}`,
      format: extension,
    };
  });
  // Asset Fetchers cannot list a directory, so the browser renderer would have
  // no way to discover the theme's partials. Recording them here lets the
  // Worker ship the whole bundle in one response.
  const files = themeFiles
    .filter((file) => /\.(liquid|json)$/i.test(file) && file !== manifestFile)
    .map((file) => `/${file.split(sep).join('/')}`)
    .sort();

  await writeFile(
    join(destination, manifestFile),
    `${JSON.stringify({ ...metadata, templates, files }, null, 2)}\n`,
    'utf8',
  );
  return templates;
}

async function sourceManifestMetadata(source) {
  try {
    const parsed = JSON.parse(await readFile(join(source, manifestFile), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const { name, description, repo } = parsed;
    return {
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      ...(repo && typeof repo === 'object' ? { repo } : {}),
    };
  } catch {
    return {};
  }
}

function humanize(value) {
  return value.split('-').map((part) => part
    ? part[0].toUpperCase() + part.slice(1)
    : '').join(' ');
}

function validateEntry(entry) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.id) || entry.id === 't') {
    throw new Error(`Invalid local theme id: ${entry.id}`);
  }
  if (!entry.source || !isAbsolute(entry.source)) {
    throw new Error(`Invalid local theme source for ${entry.id}.`);
  }
}

async function readRegistry() {
  const text = await readFile(registryPath, 'utf8').catch(() => '');
  if (!text.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot parse ${registryPath}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.themes)) {
    throw new Error(`${registryPath} must contain a { "themes": [] } array.`);
  }
  const seen = new Set();
  return parsed.themes.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error(`Invalid entry in ${registryPath}.`);
    const id = typeof entry.id === 'string' ? entry.id : '';
    const source = typeof entry.source === 'string' && isAbsolute(entry.source)
      ? resolve(entry.source)
      : '';
    if (seen.has(id)) throw new Error(`Duplicate local theme id in ${registryPath}: ${id}`);
    seen.add(id);
    return { id, source, link: entry.link === true };
  });
}

const templates = await syncTheme();
process.stdout.write(
  singleMode
    ? `Theme views synced from ${entries[0].source} to ${legacyDestination} (${templates.length} templates)\n`
    : `Local themes synced to ${themesRoot} (${entries.length} themes, ${templates.length} templates)\n`,
);

if (pushMode) await pushToBucket();

/**
 * Uploads one or every staged theme into the themes bucket. It goes through
 * the plugin rather than the R2 API so the same command fills local Wrangler
 * storage and a real bucket.
 */
async function pushToBucket() {
  const secret = process.env.PLUGIN_SECRET || await readSecret();
  const targets = singleMode
    ? [{ id: entries[0].id, destination: legacyDestination }]
    : entries.map((entry) => ({ id: entry.id, destination: join(themesRoot, entry.id) }));
  for (const target of targets) await pushOne(secret, target.id, target.destination);
}

async function pushOne(secret, id, destination) {
  const files = {};
  for (const file of await listThemeFiles(destination)) {
    const path = `/${file.split(sep).join('/')}`;
    const bytes = await readFile(join(destination, file));
    files[path] = BINARY_EXTENSION.test(extname(file))
      ? { encoding: 'base64', content: bytes.toString('base64') }
      : { encoding: 'utf8', content: bytes.toString('utf8') };
  }

  const response = await fetch(
    `${pluginUrl}/__plugin/admin/upload?theme=${encodeURIComponent(id)}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-plugin-secret': secret,
        'x-cms-user': JSON.stringify({ id: 'theme-sync', role: 'admin' }),
        ...(cmsTenant ? { 'x-cms-tenant': cmsTenant } : {}),
      },
      body: JSON.stringify(files),
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.message || `Upload failed with ${response.status}. Is \`npm run dev\` running?`);
  }
  process.stdout.write(`Pushed ${payload.written} files to bucket theme ${id}\n`);
}

async function readSecret() {
  const vars = await readFile(join(projectRoot, '.dev.vars'), 'utf8').catch(() => '');
  const match = /^PLUGIN_SECRET\s*=\s*(.+)$/m.exec(vars);
  if (!match) throw new Error('No PLUGIN_SECRET: set it in .dev.vars or the environment.');
  return match[1].trim().replace(/^["']|["']$/g, '');
}

if (watchMode) startWatching();

/**
 * Without this the destination is only a snapshot taken before `wrangler dev`
 * started, so theme edits never reach the editor preview until the dev server
 * is restarted. Wrangler reloads the asset subtree on its own once the files
 * change here.
 */
function startWatching() {
  let timer = null;
  let running = false;
  let pending = false;

  const run = async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      const synced = await syncTheme();
      process.stdout.write(`Theme views resynced (${synced.length} templates)\n`);
    } catch (error) {
      process.stderr.write(`Theme sync failed: ${error.message}\n`);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        run();
      }
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  };

  for (const entry of entries) {
    try {
      watch(entry.source, { recursive: true }, schedule);
    } catch (error) {
      process.stderr.write(
        `Cannot watch ${entry.source} (${error.message}). Run \`npm run theme:sync\` after theme edits.\n`,
      );
    }
  }
  process.stdout.write(`Watching ${entries.map((entry) => entry.source).join(', ')} for theme changes\n`);
}
