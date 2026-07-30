import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copies the host CMS's LiquidJS bundle in for the tests. Nothing ships it:
 * the admin page already loads `/assets/liquid.browser.min.js` and every
 * approved plugin asset runs after it, so the preview reads that global rather
 * than bundling a second engine. Tests stand in for the admin page, and they
 * have to install the same file — it is LiquidJS plus the CMS's own `schema`
 * tag, so the npm package would be a different engine from the one that renders
 * the preview and the admin view in a browser.
 *
 * The copy is ignored, so it cannot rot in the repo.
 */
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const configuredSource = process.env.CMS_ASSETS_DIR?.trim();
if (!configuredSource) {
  throw new Error('CMS_ASSETS_DIR is required. Point it at the host CMS asset directory to sync (cms/views/assets).');
}

const file = 'liquid.browser.min.js';
const source = resolve(configuredSource, file);
const destination = resolve(projectRoot, 'test/vendor', file);

await mkdir(dirname(destination), { recursive: true });
try {
  await copyFile(source, destination);
} catch (error) {
  throw new Error(`Could not read ${source}: ${error instanceof Error ? error.message : String(error)}`);
}

// Report the version so a host upgrade is visible here rather than only in a
// test that starts failing for no apparent reason.
const version = /version="([^"]+)"/.exec(await readFile(destination, 'utf8'))?.[1] ?? 'unknown';
process.stdout.write(`Synced ${file} (LiquidJS ${version}) from ${configuredSource}\n`);
