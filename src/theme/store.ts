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
 * A store the Worker can edit. Asset bindings are immutable at runtime, so this
 * is what a bucket-backed theme adds: the deployed editor can write the theme
 * it renders instead of only layering overrides over files it cannot reach.
 */
export interface WritableThemeStore extends ThemeStore {
  write(path: string, content: string): Promise<void>;
  list(): Promise<string[]>;
}

export function isWritable(store: ThemeStore): store is WritableThemeStore {
  return typeof (store as WritableThemeStore).write === 'function';
}

/**
 * One theme inside a bucket that holds several, keyed `<theme-id>/<path>`.
 * The bucket is the root: each top-level folder is a theme, so adding one is
 * uploading a folder rather than changing this Worker.
 */
export class R2ThemeStore implements WritableThemeStore {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly themeId: string,
  ) {}

  async read(path: string): Promise<string> {
    const object = await this.bucket.get(this.key(path));
    if (!object) throw new Error(`Theme file not found: ${path}`);
    return object.text();
  }

  async exists(path: string): Promise<boolean> {
    return await this.bucket.head(this.key(path)) !== null;
  }

  async write(path: string, content: string): Promise<void> {
    await this.bucket.put(this.key(path), content, {
      httpMetadata: { contentType: contentTypeFor(path) },
    });
  }

  /** Every file in this theme, as store paths. */
  async list(): Promise<string[]> {
    const prefix = `${this.themeId}/`;
    const paths: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor, limit: 1000 });
      for (const object of page.objects) paths.push(object.key.slice(prefix.length - 1));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return paths;
  }

  private key(path: string): string {
    return `${this.themeId}${normalize(path)}`;
  }
}

/** Top-level folders in the bucket, one per theme. */
export async function bucketThemeIds(bucket: R2Bucket): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ delimiter: '/', cursor, limit: 1000 });
    for (const prefix of page.delimitedPrefixes) {
      const id = prefix.replace(/\/$/, '');
      if (/^[a-z0-9][a-z0-9-]*$/.test(id)) ids.push(id);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return ids.sort();
}

function contentTypeFor(path: string): string {
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.js')) return 'text/javascript';
  return 'text/plain; charset=utf-8';
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

