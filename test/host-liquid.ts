import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Stands in for the admin page, which loads `/assets/liquid.browser.min.js`
 * before any approved plugin asset runs. Importing this installs that same file
 * on `globalThis` — which is exactly where `src/theme/liquid.ts` and the built
 * preview bundle look for it — so nothing under test carries its own engine.
 *
 * The host's file is not the npm package: it is LiquidJS with the CMS's own
 * `schema` tag patched into the default tag registry. Testing against the
 * package would test an engine the browser never runs.
 */
const bundle = resolve(process.cwd(), 'test/vendor/liquid.browser.min.js');

export interface HostLiquid {
  Liquid: new (options?: Record<string, unknown>) => {
    parseAndRender(source: string, data: Record<string, unknown>): Promise<unknown>;
    registerFilter(name: string, filter: (...args: unknown[]) => unknown): void;
  };
}

function install(): void {
  let source: string;
  try {
    source = readFileSync(bundle, 'utf8');
  } catch {
    throw new Error(
      `Missing ${bundle}. Run: CMS_ASSETS_DIR=<cms>/views/assets npm run liquid:sync`,
    );
  }
  // The UMD is called with `this` as the global, so it installs itself there;
  // the CMS's appended `schema` tag then resolves `liquidjs` from that global.
  new Function(source)();
}

install();

/** The host's engine, for tests that render a view the way the CMS does. */
export function hostLiquid(): HostLiquid {
  const module = (globalThis as { liquidjs?: HostLiquid }).liquidjs;
  if (!module) throw new Error('The host LiquidJS bundle did not install itself');
  return module;
}

/** A host-like engine with the CMS translation filter available to view tests. */
export function testLiquid(
  options: Record<string, unknown> = {},
  catalog: Record<string, string> = {},
): InstanceType<HostLiquid['Liquid']> {
  const engine = new (hostLiquid().Liquid)(options);
  engine.registerFilter('t', (...args: unknown[]) => {
    const [key, fallback] = args;
    const messageKey = String(key ?? '');
    return catalog[messageKey]
      ?? (fallback === undefined || fallback === null ? messageKey : String(fallback));
  });
  return engine;
}
