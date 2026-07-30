import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = resolve(projectRoot, 'views');
const destination = resolve(projectRoot, '.dist/views');
const developmentTheme = resolve(source, 'theme');
const includeDevelopmentTheme = process.env.INCLUDE_DEV_THEME === '1';

// Build from a clean directory so ignored development theme files cannot leak
// into a deployment merely because somebody ran theme:sync earlier.
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, {
  recursive: true,
  force: true,
  filter: (path) => includeDevelopmentTheme
    || path === source
    || !path.startsWith(developmentTheme),
});

process.stdout.write(`Plugin assets prepared in ${destination}\n`);
