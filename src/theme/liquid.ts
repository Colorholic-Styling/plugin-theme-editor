import { Liquid, TypeGuards } from 'liquidjs';
import type { ThemeStore } from './store';

function engine(store: ThemeStore, globals: Record<string, unknown>): Liquid {
  const liquid = new Liquid({
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
function registerSchemaTag(liquid: Liquid): void {
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
