import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultSource = '/Users/colin/Documents/code/projects/colorholicstyling/www/views';
const source = resolve(process.env.THEME_SOURCE_DIR || defaultSource);
const destination = resolve(projectRoot, 'views/theme');

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

process.stdout.write(`Theme views synced from ${source} to ${destination}\n`);

