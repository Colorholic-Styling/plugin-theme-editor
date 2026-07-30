import type { ThemeStore } from './store';

/**
 * The host CMS already ships LiquidJS: every admin page loads
 * `/assets/liquid.browser.min.js` — a UMD build that defines `liquidjs` on the
 * global — for its own client-side view rendering, and an approved plugin asset
 * is injected after it. The preview reads that global instead of bundling a
 * second copy, so the theme is parsed by the same engine the admin UI uses and
 * the approval-gated asset stays small.
 */
interface LiquidToken {
  file?: string;
  getText(): string;
}

interface LiquidTagToken extends LiquidToken {
  name: string;
}

interface LiquidTag {
  parse(token: LiquidTagToken, remainTokens: LiquidToken[]): void;
  render(): string;
}

interface LiquidFS {
  readFileSync(file: string): string;
  readFile(file: string): Promise<string>;
  existsSync(file: string): boolean;
  exists(file: string): Promise<boolean>;
  contains(root: string, file: string): Promise<boolean>;
  containsSync(root: string, file: string): boolean;
  resolve(root: string, file: string, ext: string): string;
}

interface LiquidOptions {
  cache: boolean;
  extname: string;
  globals: Record<string, unknown>;
  root: string[];
  relativeReference: boolean;
  fs: LiquidFS;
}

interface LiquidEngine {
  registerTag(name: string, tag: LiquidTag): void;
  parseAndRender(source: string, data: Record<string, unknown>): Promise<unknown>;
}

interface LiquidModule {
  Liquid: new (options: LiquidOptions) => LiquidEngine;
  TypeGuards: { isTagToken(token: LiquidToken): token is LiquidTagToken };
}

function liquidjs(): LiquidModule {
  const module = (globalThis as { liquidjs?: LiquidModule }).liquidjs;
  if (!module) {
    throw new Error(
      'LiquidJS is unavailable: the theme preview runs on an admin page, which loads /assets/liquid.browser.min.js',
    );
  }
  return module;
}

function engine(store: ThemeStore, globals: Record<string, unknown>): LiquidEngine {
  const liquid = new (liquidjs().Liquid)({
    cache: true,
    extname: '.liquid',
    globals,
    root: ['/'],
    relativeReference: false,
    fs: {
      readFileSync(file: string): string {
        throw new Error(`Synchronous theme reads are not supported: ${file}`);
      },
      readFile(file: string): Promise<string> {
        return store.read(file);
      },
      existsSync(): boolean {
        return false;
      },
      exists(file: string): Promise<boolean> {
        return store.exists(file);
      },
      contains(): Promise<boolean> {
        return Promise.resolve(true);
      },
      containsSync(): boolean {
        return true;
      },
      resolve(_root: string, file: string, ext: string): string {
        const withExtension = file.endsWith(ext) ? file : `${file}${ext}`;
        return withExtension.startsWith('/') ? withExtension : `/${withExtension}`;
      },
    },
  });
  registerSchemaTag(liquid);
  return liquid;
}

/**
 * Shopify section schemas are editor metadata. LiquidJS does not provide this
 * tag, so consume its body without rendering it and validate the JSON while
 * the template is parsed.
 */
function registerSchemaTag(liquid: LiquidEngine): void {
  const { TypeGuards } = liquidjs();
  liquid.registerTag('schema', {
    parse(token, remainTokens) {
      const source: string[] = [];
      for (let next = remainTokens.shift(); next !== undefined; next = remainTokens.shift()) {
        if (TypeGuards.isTagToken(next) && next.name === 'endschema') {
          assertSchemaJson(source.join(''), token.file);
          return;
        }
        source.push(next.getText());
      }
      throw new Error(
        `Invalid section schema in ${token.file ?? 'template'}: {% schema %} is not closed`,
      );
    },
    render(): string {
      return '';
    },
  });
}

function assertSchemaJson(source: string, file: string | undefined): void {
  let schema: unknown;
  try {
    schema = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid section schema in ${file ?? 'template'}: ${message}`);
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`Invalid section schema in ${file ?? 'template'}: must be a JSON object`);
  }
}

export async function renderThemeSource(
  store: ThemeStore,
  source: string,
  data: Record<string, unknown>,
): Promise<string> {
  return String(await engine(store, data).parseAndRender(source, data));
}
