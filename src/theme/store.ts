/**
 * Runtime theme-file contract. Development uses a staged asset subtree; the
 * same interface can later be implemented by an R2 bucket without changing the
 * Liquid renderer or editor routes.
 */
export interface ThemeStore {
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

/**
 * Serves editor-only templates that the theme itself does not contain, and
 * delegates everything else. The preview needs to inject markup into files the
 * theme renders by path, without writing anything into the theme bundle.
 */
export class VirtualThemeStore implements ThemeStore {
  constructor(
    private readonly base: ThemeStore,
    private readonly files: Record<string, string>,
  ) {}

  read(path: string): Promise<string> {
    const virtual = this.files[normalize(path)];
    return virtual === undefined ? this.base.read(path) : Promise.resolve(virtual);
  }

  exists(path: string): Promise<boolean> {
    return normalize(path) in this.files
      ? Promise.resolve(true)
      : this.base.exists(path);
  }
}

function normalize(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

export class AssetThemeStore implements ThemeStore {
  constructor(
    private readonly assets: Fetcher,
    private readonly prefix = '/theme',
  ) {}

  async read(path: string): Promise<string> {
    const response = await this.assets.fetch(`https://views.local${this.assetPath(path)}`);
    if (!response.ok) throw new Error(`Theme file not found: ${path}`);
    return response.text();
  }

  async exists(path: string): Promise<boolean> {
    const response = await this.assets.fetch(`https://views.local${this.assetPath(path)}`);
    return response.ok;
  }

  private assetPath(path: string): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `${this.prefix}${normalized}`;
  }
}

