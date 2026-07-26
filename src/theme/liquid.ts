import { Liquid } from 'liquidjs';
import type { ThemeStore } from './store';

function engine(store: ThemeStore, globals: Record<string, unknown>): Liquid {
  return new Liquid({
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
}

export async function renderThemeSource(
  store: ThemeStore,
  source: string,
  data: Record<string, unknown>,
): Promise<string> {
  return String(await engine(store, data).parseAndRender(source, data));
}

