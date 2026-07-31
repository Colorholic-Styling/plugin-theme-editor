import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPluginStateCache, clearTenantCache, tenantRef } from '@lionrockjs/worker-cms-plugin';
import { cmsState, themeOverridesKey } from './cms-state';
import worker from '../src/index';
import { availableThemes, themeStore } from '../src/themes';
import { deleteBucketTheme, isWritable } from '../src/theme/store';
import type { PluginEnv } from '../src/types';

const SECRET = 'theme-editor-test-secret';
const plugin = worker as { fetch(request: Request, env: PluginEnv): Promise<Response> };

function views(): Fetcher {
  return {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      try {
        const root = url.pathname.startsWith('/theme/')
          ? `./fixtures${url.pathname}`
          : `../views${url.pathname}`;
        const path = fileURLToPath(new URL(root, import.meta.url).href);
        return new Response(await readFile(path), { headers: { 'content-type': 'text/plain' } });
      } catch {
        return new Response('not found', { status: 404 });
      }
    },
  } as Fetcher;
}

/**
 * In-memory R2, keyed exactly as the bucket is: `<theme-id>/<path>`. The bucket
 * is the theme root, so a top-level folder is a theme.
 */
function bucket(seed: Record<string, string> = {}): R2Bucket & { store: Map<string, string> } {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (key: string) => store.has(key)
      ? { text: async () => store.get(key) as string }
      : null,
    head: async (key: string) => store.has(key) ? {} : null,
    put: async (key: string, value: string) => void store.set(key, value),
    // R2 accepts one key or a batch; a delete of many is one call.
    delete: async (key: string | string[]) => {
      for (const entry of Array.isArray(key) ? key : [key]) store.delete(entry);
    },
    list: async ({ prefix = '', delimiter }: { prefix?: string; delimiter?: string } = {}) => {
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix));
      if (!delimiter) {
        return { objects: keys.map((key) => ({ key })), delimitedPrefixes: [], truncated: false };
      }
      const prefixes = new Set<string>();
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const cut = rest.indexOf(delimiter);
        if (cut >= 0) prefixes.add(`${prefix}${rest.slice(0, cut + 1)}`);
      }
      return { objects: [], delimitedPrefixes: [...prefixes], truncated: false };
    },
  } as unknown as R2Bucket & { store: Map<string, string> };
}

const PAGE_TEMPLATE = JSON.stringify({
  layout: 'default',
  sections: {
    hero: { type: 'hero', settings: { title: '{{ page.blocks[0].title }}' } },
    cta: { type: 'cta', settings: {} },
  },
  order: ['hero', 'cta'],
}, null, 2);

function themeFiles(id: string): Record<string, string> {
  return {
    [`${id}/theme-manifest.json`]: JSON.stringify({
      name: id === 'studio-minimal' ? 'Studio Minimal' : '',
      templates: [{ id: 'page', label: 'Page', path: '/templates/page.json', format: 'json' }],
      files: ['/templates/page.json'],
    }),
    [`${id}/templates/page.json`]: PAGE_TEMPLATE,
    [`${id}/assets/site.css`]: 'body { color: rebeccapurple; }',
  };
}

/** Re-keys a theme fixture under a tenant's prefix. */
function prefixed(prefix: string, files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([key, value]) => [`${prefix}${key}`, value]));
}

function env(overrides: Partial<PluginEnv> = {}): PluginEnv {
  return {
    VIEWS: views(),
    CMS_URL: 'https://cms.example.com',
    PLUGIN_SECRET: SECRET,
    THEME_ID: 'example-theme',
    THEME_SITE_TITLE: 'Preview site',
    // Tests exercise the pre-multi-tenant install unless they say otherwise;
    // it is the one that keeps unprefixed keys.
    CMS_TENANT_LEGACY: '1',
    ...overrides,
  };
}

function adminRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('x-plugin-secret', SECRET);
  headers.set('x-cms-user', JSON.stringify({ id: '42', role: 'editor' }));
  return new Request(`https://plugin.example.com${path}`, { ...init, headers });
}

function kv(seed: Record<string, string> = {}): KVNamespace & { store: Map<string, string> } {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    list: async ({ prefix = '' }: { prefix?: string } = {}) => ({
      keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

/** The host's plugin-state store — where the override layer now lives. */
let state = cmsState();

/**
 * Installs the CMS stub. The override layer is read on nearly every editor
 * path, so these need the host answering even when they ask it nothing else.
 */
function mockCms(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const hosted = state.handle(url, init.method ?? 'GET', body);
    if (hosted) return hosted;
    return Response.json({ page_types: ['home'], languages: ['en'], default_language: 'en' });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearTenantCache();
  clearPluginStateCache();
  state = cmsState();
});

describe('bucket-backed themes', () => {
  it('reads the theme library from the bucket, one folder per theme', async () => {
    const THEMES = bucket({ ...themeFiles('example-theme'), ...themeFiles('studio-minimal') });
    const themes = await availableThemes(env({ THEMES }));

    expect(themes.map((theme) => theme.id)).toEqual(['example-theme', 'studio-minimal']);
    expect(themes.every((theme) => theme.storage === 'bucket')).toBe(true);
    // A theme names itself in its own manifest, so the bucket stays the registry.
    expect(themes.find((theme) => theme.id === 'studio-minimal')?.name).toBe('Studio Minimal');
    expect(themes.find((theme) => theme.id === 'example-theme')?.name).toBe('Example Theme');
  });

  it('keeps two tenants apart even when their themes share an id', async () => {
    // One bucket serves every connected CMS and R2 has no per-prefix access
    // control, so the key prefix IS the boundary: without it, two tenants that
    // clone repositories of the same name overwrite each other's theme.
    const one = await tenantRef('https://one.example.com');
    const two = await tenantRef('https://two.example.com');
    const THEMES = bucket({
      ...prefixed(`t/${one}/`, themeFiles('portfolio')),
      ...prefixed(`t/${two}/`, themeFiles('portfolio')),
      ...prefixed(`t/${two}/`, themeFiles('studio-minimal')),
    });

    const first = await availableThemes(env({
      THEMES,
      CMS_TENANT_REF: one,
      CMS_TENANT_LEGACY: undefined,
    }));
    expect(first.map((theme) => theme.id)).toEqual(['portfolio']);

    const second = await availableThemes(env({
      THEMES,
      CMS_TENANT_REF: two,
      CMS_TENANT_LEGACY: undefined,
    }));
    expect(second.map((theme) => theme.id)).toEqual(['portfolio', 'studio-minimal']);
  });

  it('writes a tenant theme under its own prefix', async () => {
    const ref = await tenantRef('https://one.example.com');
    const THEMES = bucket(prefixed(`t/${ref}/`, themeFiles('portfolio')));
    const pluginEnv = env({ THEMES, CMS_TENANT_REF: ref, CMS_TENANT_LEGACY: undefined });
    const [theme] = await availableThemes(pluginEnv);

    const store = themeStore(pluginEnv, theme);
    if (!isWritable(store)) throw new Error('a bucket-backed theme must be writable');
    await store.write('/templates/page.json', '{}');

    expect(THEMES.store.has(`t/${ref}/portfolio/templates/page.json`)).toBe(true);
    expect(THEMES.store.has('portfolio/templates/page.json')).toBe(false);
  });

  it('leaves the pre-multi-tenant install on its unprefixed keys', async () => {
    // The env-fallback tenant predates the prefix, so its existing themes must
    // stay reachable — and the reserved `t/` namespace must not look like one.
    const THEMES = bucket({
      ...themeFiles('example-theme'),
      ...prefixed('t/abc123/', themeFiles('someone-elses')),
    });
    const themes = await availableThemes(env({ THEMES }));
    expect(themes.map((theme) => theme.id)).toEqual(['example-theme']);
  });

  it('falls back to the staged development theme with no bucket', async () => {
    const themes = await availableThemes(env());
    expect(themes).toHaveLength(1);
    expect(themes[0]).toMatchObject({ id: 'example-theme', storage: 'asset' });
    // An asset bundle is immutable at runtime, so that theme cannot be written.
    expect(isWritable(themeStore(env(), themes[0]))).toBe(false);
  });

  it('does not invent a development theme in a clean production build', async () => {
    const VIEWS = {
      fetch: async () => new Response('not found', { status: 404 }),
    } as unknown as Fetcher;

    expect(await availableThemes(env({ THEMES: bucket(), VIEWS }))).toEqual([]);
  });

  it('gives a bucket theme a writable store', async () => {
    const THEMES = bucket(themeFiles('example-theme'));
    const pluginEnv = env({ THEMES });
    const [theme] = await availableThemes(pluginEnv);
    const store = themeStore(pluginEnv, theme);

    expect(isWritable(store)).toBe(true);
    expect(await store.read('/templates/page.json')).toBe(PAGE_TEMPLATE);
    expect(await store.exists('/templates/missing.json')).toBe(false);
  });

  it('serves CSS from the selected bucket theme with a stylesheet MIME type', async () => {
    const THEMES = bucket({
      ...themeFiles('example-theme'),
      ...themeFiles('studio-minimal'),
    });
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/theme/assets/site.css?theme=studio-minimal'),
      env({ THEMES }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/css');
    expect(await response.text()).toBe('body { color: rebeccapurple; }');
  });

  it('uploads a theme folder into the bucket', async () => {
    const THEMES = bucket();
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/upload?theme=studio-minimal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          '/templates/page.json': PAGE_TEMPLATE,
          '/sections/hero.liquid': '<section></section>',
          // Paths from an upload decide bucket keys, so traversal is refused.
          '/../escape.json': 'nope',
        }),
      }),
      env({ THEMES }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      theme: 'studio-minimal',
      written: 2,
    });
    expect(THEMES.store.get('studio-minimal/templates/page.json')).toBe(PAGE_TEMPLATE);
    expect([...THEMES.store.keys()].some((key) => key.includes('..'))).toBe(false);
  });

  it('publishes overrides into the bucket and clears them', async () => {
    const THEMES = bucket(themeFiles('example-theme'));
    mockCms();
    // Seeded in the pre-migration KV namespace, so this also covers an install
    // whose pending edits predate the move to the host: they are adopted on
    // read, used, and the old namespace drains.
    const THEME_OVERRIDES = kv({
      [`sections:${await tenantRef('https://cms.example.com')}:example-theme:page`]: JSON.stringify({
        hidden: ['cta'],
        settings: { hero: { title: '{{ page.blocks[0].eyebrow }}' } },
      }),
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/publish', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ theme: 'example-theme' }),
      }),
      env({ THEMES, THEME_OVERRIDES }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      // Nothing to push: this theme did not come from a repository.
      pushed: false,
      published: [{ template: 'page', changes: ['order: removed cta', expect.stringContaining('hero.title')] }],
    });

    // The Worker wrote the theme's own file — the thing an asset binding makes
    // impossible.
    const written = JSON.parse(THEMES.store.get('example-theme/templates/page.json') as string);
    expect(written.order).toEqual(['hero']);
    expect(written.sections.hero.settings.title).toBe('{{ page.blocks[0].eyebrow }}');
    // The hidden section keeps its definition, so showing it again is putting
    // the key back rather than rebuilding it.
    expect(written.sections.cta).toBeDefined();
    // Cleared from the host, and drained from the namespace it was adopted out of.
    expect(state.store.has(themeOverridesKey('example-theme'))).toBe(false);
    expect(THEME_OVERRIDES.store.size).toBe(0);
  });

  it('deletes a theme with its pending edits, and nothing else', async () => {
    const THEMES = bucket({ ...themeFiles('example-theme'), ...themeFiles('studio-minimal') });
    mockCms();
    state = cmsState({
      [themeOverridesKey('example-theme')]: { page: { hidden: ['cta'], settings: {} } },
      // Another theme's edits are a separate key and must survive.
      [themeOverridesKey('studio-minimal')]: { page: { hidden: ['hero'], settings: {} } },
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/delete', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ theme: 'example-theme', confirm_id: 'example-theme' }),
      }),
      env({ THEMES }),
    );
    expect(response.status).toBe(200);
    expect((await response.json() as { message: string }).message).toContain('Deleted');

    expect([...THEMES.store.keys()].some((key) => key.startsWith('example-theme/'))).toBe(false);
    expect([...THEMES.store.keys()].some((key) => key.startsWith('studio-minimal/'))).toBe(true);
    // Overrides are keyed by theme id, so leaving them would hand a theme
    // later cloned under this id the deleted one's hidden sections.
    expect(state.store.has(themeOverridesKey('example-theme'))).toBe(false);
    expect(state.store.has(themeOverridesKey('studio-minimal'))).toBe(true);
  });

  it('will not delete without the theme id typed back', async () => {
    const THEMES = bucket(themeFiles('example-theme'));
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/delete', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ theme: 'example-theme', confirm_id: 'wrong' }),
      }),
      env({ THEMES }),
    );
    expect(response.status).toBe(400);
    // The confirm dialog is a browser behavior the request never sees, so a
    // stray POST must not be enough on its own.
    expect(THEMES.store.has('example-theme/templates/page.json')).toBe(true);
  });

  it('refuses to delete a theme the deploy owns rather than the bucket', async () => {
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/delete', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ theme: 'example-theme', confirm_id: 'example-theme' }),
      }),
      env(),
    );
    expect(response.status).toBe(400);
    expect((await response.json() as { message: string }).message).toContain('asset bundle');
  });

  it('deletes only inside the tenant that asked', async () => {
    // The prefix is rebuilt from the scope rather than taken from the caller,
    // so a delete cannot reach across tenants even when the theme ids match.
    const one = await tenantRef('https://one.example.com');
    const two = await tenantRef('https://two.example.com');
    const THEMES = bucket({
      ...prefixed(`t/${one}/`, themeFiles('portfolio')),
      ...prefixed(`t/${two}/`, themeFiles('portfolio')),
      // The pre-multi-tenant install's own unprefixed theme of the same name.
      ...themeFiles('portfolio'),
    });

    const removed = await deleteBucketTheme(THEMES, 'portfolio', { tenantRef: one });
    expect(removed).toBe(3);

    expect([...THEMES.store.keys()].some((key) => key.startsWith(`t/${one}/portfolio/`))).toBe(false);
    expect([...THEMES.store.keys()].some((key) => key.startsWith(`t/${two}/portfolio/`))).toBe(true);
    expect(THEMES.store.has('portfolio/templates/page.json')).toBe(true);
  });

  it('explains a theme with no templates instead of redirecting to itself', async () => {
    // A theme repository has no manifest — it is a build product — so a clone
    // that did not generate one leaves a theme with no templates. The editor
    // used to answer that by redirecting to the URL it was already on.
    const THEMES = bucket({
      'website/theme-manifest.json': JSON.stringify({ repo: { owner: 'o', repo: 'website' } }),
      'website/templates/page.json': PAGE_TEMPLATE,
    });
    vi.stubGlobal('fetch', async () => Response.json({
      page_types: ['home'], languages: ['en'], default_language: 'en',
    }));

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/editor?theme=website'),
      env({ THEMES }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    const data = await response.json() as { heading: string; message: string };
    expect(data.heading).toContain('has no templates');
    expect(data.message).toContain('templates/');
  });

  it('refuses to publish a theme served from the immutable asset bundle', async () => {
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ theme: 'example-theme' }),
      }),
      env(),
    );
    expect(response.status).toBe(409);
    const payload = await response.json() as { message: string };
    expect(payload.message).toContain('theme:apply');
  });
});
