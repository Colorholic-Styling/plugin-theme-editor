import { lstat, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const registryPath = resolve(
  projectRoot,
  process.env.THEME_REGISTRY_FILE?.trim() || 'local-themes.json',
);

const args = parseArgs(process.argv.slice(2));
const themeId = args.id || process.env.THEME_ID?.trim() || '';
const sourcePath = args.source || process.env.THEME_SOURCE_DIR?.trim() || '';
const link = args.copy ? false : args.link || process.env.THEME_LINK === '1';

if (!themeId || !/^[a-z0-9][a-z0-9-]*$/.test(themeId) || themeId === 't') {
  throw new Error('Use --id with a lowercase theme id containing only letters, numbers, and dashes.');
}
if (!sourcePath || !isAbsolute(sourcePath)) {
  throw new Error('Use --source with an absolute theme source directory.');
}

const source = resolve(sourcePath);
const sourceInfo = await lstat(source).catch(() => null);
if (!sourceInfo?.isDirectory()) {
  throw new Error(`Theme source directory does not exist: ${source}`);
}

const current = await readRegistry();
const themes = current.filter((entry) => entry.id !== themeId);
themes.push({ id: themeId, source, link });
themes.sort((one, two) => one.id.localeCompare(two.id));
await writeFile(registryPath, `${JSON.stringify({ themes }, null, 2)}\n`, 'utf8');

process.stdout.write(
  `${link ? 'Linked' : 'Registered'} local theme ${themeId} from ${source} in ${registryPath}\n`,
);

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
  return parsed.themes
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : '',
      source: typeof entry.source === 'string' ? entry.source : '',
      link: entry.link === true,
    }))
    .filter((entry) => /^[a-z0-9][a-z0-9-]*$/.test(entry.id) && entry.id !== 't' && isAbsolute(entry.source));
}

function parseArgs(values) {
  const result = { id: '', source: '', link: false, copy: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--link') result.link = true;
    else if (value === '--copy') result.copy = true;
    else if (value === '--id') result.id = values[++index] || '';
    else if (value === '--source') result.source = values[++index] || '';
    else if (value === '--help' || value === '-h') {
      process.stdout.write(
        'Usage: npm run theme:add -- --id <theme-id> --source <absolute-path> [--link|--copy]\n',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }
  return result;
}
