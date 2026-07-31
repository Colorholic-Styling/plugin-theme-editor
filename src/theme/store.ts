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
export class R2ThemeStore implements WritableThemeStore {
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
