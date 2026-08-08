import { themeContentType } from './files';

/**
 * Runtime theme-file contract. Development uses a staged asset subtree; the
 * same interface can later be implemented by an R2 bucket without changing the
 * Liquid renderer or editor routes. Binary assets are exposed through the
 * optional byte capability below so text rendering remains unchanged.
 */
export interface ThemeStore {
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

/** Store capability used when serving a theme asset over HTTP. */
export interface BinaryThemeStore extends ThemeStore {
  readBytes(path: string): Promise<ArrayBuffer>;
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
 * Themes are stored per tenant, under `t/<tenant-ref>/<theme-id>/<path>`.
 *
 * One bucket serves every CMS this Worker is connected to, and R2 has no
 * per-prefix access control, so this prefix IS the isolation boundary: without
 * it two tenants that clone repositories of the same name write to the same
 * folder and overwrite each other. It is derived here, from a tenant handle,
 * rather than accepted as a caller-supplied key — that keeps the boundary in
 * one place instead of at every call site.
 *
 * The env-fallback tenant (a single pre-multi-tenant install) keeps reading
 * and writing unprefixed keys, so its existing themes stay reachable.
 */
export class R2ThemeStore implements WritableThemeStore, BinaryThemeStore {
  private readonly prefix: string;

  constructor(
    private readonly bucket: R2Bucket,
    private readonly themeId: string,
    scope: ThemeScope = {},
  ) {
    this.prefix = themePrefix(scope);
  }

  async read(path: string): Promise<string> {
    const object = await this.bucket.get(this.key(path));
    if (!object) throw new Error(`Theme file not found: ${path}`);
    return object.text();
  }

  async readBytes(path: string): Promise<ArrayBuffer> {
    const object = await this.bucket.get(this.key(path));
    if (!object) throw new Error(`Theme file not found: ${path}`);
    if (typeof object.arrayBuffer === 'function') return object.arrayBuffer();
    return new TextEncoder().encode(await object.text()).buffer;
  }

  async exists(path: string): Promise<boolean> {
    return await this.bucket.head(this.key(path)) !== null;
  }

  async write(path: string, content: string): Promise<void> {
    await this.bucket.put(this.key(path), content, {
      httpMetadata: { contentType: themeContentType(path) },
    });
  }

  async writeBytes(path: string, content: ArrayBuffer | ArrayBufferView): Promise<void> {
    await this.bucket.put(this.key(path), content, {
      httpMetadata: { contentType: themeContentType(path) },
    });
  }

  /** Every file in this theme, as store paths. */
  async list(): Promise<string[]> {
    const prefix = `${this.prefix}${this.themeId}/`;
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
    return `${this.prefix}${this.themeId}${normalize(path)}`;
  }
}

/** Which tenant's themes a store or listing addresses. */
export interface ThemeScope {
  /** Tenant ref (`env.CMS_TENANT_REF`). Absent means the legacy layout. */
  tenantRef?: string;
  /** True for the env-fallback tenant, which keeps the unprefixed layout. */
  legacy?: boolean;
}

/**
 * Top-level key that holds every tenant's themes. Reserved: at the legacy
 * (unprefixed) level it must not be mistaken for — or claimed as — a theme,
 * or one install's folder would shadow every other tenant's storage.
 */
export const TENANT_KEY_PREFIX = 't';

/** True for a theme id that must not be created, whatever the scope. */
export function isReservedThemeId(themeId: string): boolean {
  return themeId === TENANT_KEY_PREFIX;
}

/**
 * Key prefix for a scope: `t/<ref>/`, or none for the legacy single-tenant
 * install. An unidentified tenant also gets none rather than a namespace of
 * its own — callers reach this only through authenticated requests, so a
 * missing ref means the legacy install.
 */
export function themePrefix(scope: ThemeScope): string {
  if (scope.legacy || !scope.tenantRef) return '';
  return `${TENANT_KEY_PREFIX}/${scope.tenantRef}/`;
}

/**
 * Removes every object belonging to one theme, and nothing else.
 *
 * The prefix is rebuilt from the scope rather than taken from a caller, so a
 * delete can only ever reach inside the tenant that asked for it — the same
 * invariant `R2ThemeStore` keeps for reads and writes. Returns how many objects
 * were removed, which is what tells an empty theme id from a real one.
 */
export async function deleteBucketTheme(
  bucket: R2Bucket,
  themeId: string,
  scope: ThemeScope = {},
): Promise<number> {
  const prefix = `${themePrefix(scope)}${themeId}/`;
  let removed = 0;
  // Re-listed each round rather than paged through: delete invalidates the
  // cursor, and the listing shrinks as the deletes land, so this terminates.
  for (;;) {
    const page = await bucket.list({ prefix, limit: 1000 });
    const keys = page.objects.map((object) => object.key);
    if (keys.length === 0) return removed;
    await bucket.delete(keys);
    removed += keys.length;
  }
}

/** Theme folders visible to one tenant. */
export async function bucketThemeIds(bucket: R2Bucket, scope: ThemeScope = {}): Promise<string[]> {
  const prefix = themePrefix(scope);
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, delimiter: '/', cursor, limit: 1000 });
    for (const delimited of page.delimitedPrefixes) {
      const id = delimited.slice(prefix.length).replace(/\/$/, '');
      if (isReservedThemeId(id)) continue;
      if (/^[a-z0-9][a-z0-9-]*$/.test(id)) ids.push(id);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return ids.sort();
}

export function contentTypeFor(path: string): string {
  return themeContentType(path);
}

/**
 * Serves editor-only templates that the theme itself does not contain, and
 * delegates everything else. The preview needs to inject markup into files the
 * theme renders by path, without writing anything into the theme bundle.
 */
export class VirtualThemeStore implements ThemeStore, BinaryThemeStore {
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

  async readBytes(path: string): Promise<ArrayBuffer> {
    const virtual = this.files[normalize(path)];
    if (virtual !== undefined) {
      return new TextEncoder().encode(virtual).buffer;
    }
    const base = this.base as Partial<BinaryThemeStore>;
    if (typeof base.readBytes !== 'function') {
      return new TextEncoder().encode(await this.base.read(path)).buffer;
    }
    return base.readBytes(path);
  }
}

function normalize(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

export class AssetThemeStore implements ThemeStore, BinaryThemeStore {
  constructor(
    private readonly assets: Fetcher,
    private readonly prefix = '/theme',
  ) {}

  async read(path: string): Promise<string> {
    const response = await this.assets.fetch(`https://views.local${this.assetPath(path)}`);
    if (!response.ok) throw new Error(`Theme file not found: ${path}`);
    return response.text();
  }

  async readBytes(path: string): Promise<ArrayBuffer> {
    const response = await this.assets.fetch(`https://views.local${this.assetPath(path)}`);
    if (!response.ok) throw new Error(`Theme file not found: ${path}`);
    return response.arrayBuffer();
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
