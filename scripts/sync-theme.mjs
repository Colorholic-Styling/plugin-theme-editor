import { watch } from 'node:fs';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultSource = '/Users/colin/Documents/code/projects/colorholicstyling/www/views';
const source = resolve(process.env.THEME_SOURCE_DIR || defaultSource);
const destination = resolve(projectRoot, 'views/theme');
const manifestFile = 'theme-manifest.json';
const watchMode = process.argv.includes('--watch');

/**
 * Copy in place and prune what the source dropped. Deleting the destination
 * first would make every theme file briefly missing, and `wrangler dev` serves
 * this subtree live, so a preview rendered during the gap would fail.
 */
async function syncTheme() {
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
  await pruneRemovedFiles();
  return writeManifest();
}

async function pruneRemovedFiles() {
  const sourceFiles = new Set(await listFiles(source));
  for (const file of await listFiles(destination)) {
    if (file === manifestFile || sourceFiles.has(file)) continue;
    await rm(join(destination, file), { force: true });
  }
}

async function listFiles(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full, base));
    else files.push(relative(base, full));
  }
  return files;
}

async function writeManifest() {
  const templatesDirectory = join(destination, 'templates');
  const templateFiles = (await readdir(templatesDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(json|liquid)$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const templates = templateFiles.map((file) => {
    const extension = file.endsWith('.json') ? 'json' : 'liquid';
    const id = basename(file, `.${extension}`);
    return {
      id,
      label: id
        .split('-')
        .map((part) => part ? part[0].toUpperCase() + part.slice(1) : '')
        .join(' '),
      path: `/templates/${file}`,
      format: extension,
    };
  });
  // Asset Fetchers cannot list a directory, so the browser renderer would have
  // no way to discover the theme's partials. Recording them here lets the
  // Worker ship the whole bundle in one response.
  const files = (await listFiles(destination))
    .filter((file) => /\.(liquid|json)$/.test(file) && file !== manifestFile)
    .map((file) => `/${file.split(sep).join('/')}`)
    .sort();

  await writeFile(
    join(destination, manifestFile),
    `${JSON.stringify({ templates, files }, null, 2)}\n`,
    'utf8',
  );
  return templates;
}

const templates = await syncTheme();
process.stdout.write(
  `Theme views synced from ${source} to ${destination} (${templates.length} templates)\n`,
);

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

  try {
    watch(source, { recursive: true }, schedule);
  } catch (error) {
    process.stderr.write(
      `Cannot watch ${source} (${error.message}). Run \`npm run theme:sync\` after theme edits.\n`,
    );
    return;
  }
  process.stdout.write(`Watching ${source} for theme changes\n`);
}
