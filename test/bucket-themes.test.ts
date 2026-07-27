import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearTenantCache } from '@lionrockjs/worker-cms-plugin';
import worker from '../src/index';
import { availableThemes, themeStore } from '../src/themes';
import { isWritable } from '../src/theme/store';
import type { PluginEnv } from '../src/types';

const SECRET = 'theme-editor-test-secret';
const plugin = worker as { fetch(request: Request, env: PluginEnv): Promise<Response> };

function views(): Fetcher {
  return {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      try {
        const path = fileURLToPath(new URL(`../views${url.pathname}`, import.meta.url).href);
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
    delete: async (key: string) => void store.delete(key),
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
  };
}

function env(overrides: Partial<PluginEnv> = {}): PluginEnv {
  return {
    VIEWS: views(),
    CMS_URL: 'https://cms.example.com',
    PLUGIN_SECRET: SECRET,
    THEME_SITE_TITLE: 'Preview site',
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
  } as unknown as KVNamespace & { store: Map<string, string> };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearTenantCache();
});

describe('bucket-backed themes', () => {
  it('reads the theme library from the bucket, one folder per theme', async () => {
    const THEMES = bucket({ ...themeFiles('colorholic-styling'), ...themeFiles('studio-minimal') });
    const themes = await availableThemes(env({ THEMES }));

    expect(themes.map((theme) => theme.id)).toEqual(['colorholic-styling', 'studio-minimal']);
    expect(themes.every((theme) => theme.storage === 'bucket')).toBe(true);
    // A theme names itself in its own manifest, so the bucket stays the registry.
    expect(themes.find((theme) => theme.id === 'studio-minimal')?.name).toBe('Studio Minimal');
    expect(themes.find((theme) => theme.id === 'colorholic-styling')?.name).toBe('Colorholic Styling');
  });

  it('falls back to the staged development theme with no bucket', async () => {
    const themes = await availableThemes(env());
    expect(themes).toHaveLength(1);
    expect(themes[0]).toMatchObject({ id: 'colorholic-styling', storage: 'asset' });
    // An asset bundle is immutable at runtime, so that theme cannot be written.
    expect(isWritable(themeStore(env(), themes[0]))).toBe(false);
  });

  it('gives a bucket theme a writable store', async () => {
    const THEMES = bucket(themeFiles('colorholic-styling'));
    const pluginEnv = env({ THEMES });
    const [theme] = await availableThemes(pluginEnv);
    const store = themeStore(pluginEnv, theme);

    expect(isWritable(store)).toBe(true);
    expect(await store.read('/templates/page.json')).toBe(PAGE_TEMPLATE);
    expect(await store.exists('/templates/missing.json')).toBe(false);
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
    const THEMES = bucket(themeFiles('colorholic-styling'));
    const THEME_OVERRIDES = kv({
      'sections:https://cms.example.com:colorholic-styling:page': JSON.stringify({
        hidden: ['cta'],
        settings: { hero: { title: '{{ page.blocks[0].eyebrow }}' } },
      }),
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ theme: 'colorholic-styling' }),
      }),
      env({ THEMES, THEME_OVERRIDES }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      published: [{ template: 'page', changes: ['order: removed cta', expect.stringContaining('hero.title')] }],
    });

    // The Worker wrote the theme's own file — the thing an asset binding makes
    // impossible.
    const written = JSON.parse(THEMES.store.get('colorholic-styling/templates/page.json') as string);
    expect(written.order).toEqual(['hero']);
    expect(written.sections.hero.settings.title).toBe('{{ page.blocks[0].eyebrow }}');
    // The hidden section keeps its definition, so showing it again is putting
    // the key back rather than rebuilding it.
    expect(written.sections.cta).toBeDefined();
    expect(THEME_OVERRIDES.store.size).toBe(0);
  });

  it('refuses to publish a theme served from the immutable asset bundle', async () => {
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ theme: 'colorholic-styling' }),
      }),
      env({ THEME_OVERRIDES: kv() }),
    );
    expect(response.status).toBe(409);
    const payload = await response.json() as { message: string };
    expect(payload.message).toContain('theme:apply');
  });
});
