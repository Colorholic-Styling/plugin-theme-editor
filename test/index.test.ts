import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Liquid } from 'liquidjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearTenantCache, type CmsPage } from '@lionrockjs/worker-cms-plugin';
import worker from '../src/index';
import { applyEditorFields, editorFields } from '../src/editor-model';
import type { PluginEnv } from '../src/types';

const SECRET = 'theme-editor-test-secret';
const plugin = worker as { fetch(request: Request, env: PluginEnv): Promise<Response> };

function views(): Fetcher {
  return {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      try {
        const path = fileURLToPath(new URL(`../views${url.pathname}`, import.meta.url).href);
        const body = await readFile(path);
        const contentType = url.pathname.endsWith('.json')
          ? 'application/json'
          : url.pathname.endsWith('.css')
            ? 'text/css'
            : 'text/plain';
        return new Response(body, { headers: { 'content-type': contentType } });
      } catch {
        return new Response('not found', { status: 404 });
      }
    },
  } as Fetcher;
}

function env(overrides: Partial<PluginEnv> = {}): PluginEnv {
  return {
    VIEWS: views(),
    CMS_URL: 'https://cms.example.com',
    PLUGIN_SECRET: SECRET,
    THEME_NAME: 'Development theme',
    THEME_SITE_TITLE: 'Preview site',
    THEME_LANGUAGES: 'en,zh-hant',
    ...overrides,
  };
}

function adminRequest(
  path: string,
  init: RequestInit = {},
  user: Record<string, unknown> = { id: '42', role: 'editor' },
): Request {
  const headers = new Headers(init.headers);
  headers.set('x-plugin-secret', SECRET);
  headers.set('x-cms-user', JSON.stringify(user));
  return new Request(`https://plugin.example.com${path}`, { ...init, headers });
}

interface CmsCall {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

function mockCms(handler: (call: CmsCall) => unknown | Response): CmsCall[] {
  const calls: CmsCall[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const call: CmsCall = {
      method: init?.method ?? 'GET',
      url,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const result = handler(call);
    return result instanceof Response ? result : Response.json(result);
  });
  return calls;
}

function page(overrides: Partial<CmsPage> = {}): CmsPage {
  return {
    id: 12,
    uuid: 'page-12',
    page_type: 'home',
    name: 'Home',
    slug: 'home',
    weight: 0,
    start: null,
    end: null,
    timezone: null,
    page_id: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-26T00:00:00Z',
    lect: {
      _type: 'home',
      title: { en: 'Welcome', 'zh-hant': '歡迎' },
      subtitle: { en: 'A preview page' },
      _pointers: { feature: '91' },
      rows: [{ _weight: 10, label: { en: 'First row' }, code: 'one' }],
      _blocks: [
        {
          _id: 'hero-1',
          _type: 'hero',
          _weight: 10,
          theme: 'cream',
          title: { en: 'Hello from the theme', 'zh-hant': '主題你好' },
          body: { en: '<p>Editable copy.</p>' },
          primary: { label: { en: 'Book' }, url: { en: '/book' } },
        },
      ],
    },
    ...overrides,
  };
}

function contentMeta() {
  return {
    page_types: ['home', 'site_settings', 'news'],
    languages: ['en', 'zh-hant'],
    default_language: 'en',
  };
}

async function renderEditorSection(data: Record<string, unknown>): Promise<string> {
  const source = await readFile(fileURLToPath(new URL('../views/sections/editor.liquid', import.meta.url)), 'utf8');
  return String(await new Liquid({ outputEscape: 'escape' }).parseAndRender(source, data));
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearTenantCache();
});

describe('plugin contract', () => {
  it('declares admin-approved wildcard read and write scopes', async () => {
    const response = await plugin.fetch(new Request('https://plugin.example.com/__plugin/manifest'), env());
    expect(response.status).toBe(200);
    const manifest = await response.json() as {
      id: string;
      contentTypes: { readTypes: string[]; writeTypes: string[] };
    };
    expect(manifest.id).toBe('theme-editor');
    expect(manifest.contentTypes.readTypes).toEqual(['*']);
    expect(manifest.contentTypes.writeTypes).toEqual(['*']);
  });

  it('serves only plugin client views from the public view resolver', async () => {
    const editor = await plugin.fetch(
      new Request('https://plugin.example.com/__plugin/views/templates/editor.json'),
      env(),
    );
    expect(editor.status).toBe(200);

    const themeSource = await plugin.fetch(
      new Request('https://plugin.example.com/__plugin/views/theme/templates/page.liquid'),
      env(),
    );
    expect(themeSource.status).toBe(404);
  });

  it('rejects admin calls without the plugin secret', async () => {
    const response = await plugin.fetch(
      new Request('https://plugin.example.com/__plugin/admin/editor'),
      env(),
    );
    expect(response.status).toBe(403);
  });
});

describe('editor model', () => {
  it('exposes attributes, localized values, pointers, items, and block values', () => {
    const fixture = page();
    const pageValues = editorFields(fixture, ['en', 'zh-hant'], 'en', null);
    expect(pageValues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/title/en', value: 'Welcome', kind: 'localized' }),
      expect.objectContaining({ path: '/_pointers/feature', value: '91', kind: 'pointer' }),
      expect.objectContaining({ path: '/rows/0/label/en', value: 'First row', group: 'Rows · item 1' }),
    ]));

    const blockValues = editorFields(fixture, ['en', 'zh-hant'], 'en', 0);
    expect(blockValues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/_blocks/0/_type', value: 'hero', readOnly: true }),
      expect.objectContaining({ path: '/_blocks/0/theme', value: 'cream', kind: 'attribute' }),
      expect.objectContaining({ path: '/_blocks/0/title/en', value: 'Hello from the theme', kind: 'localized' }),
      expect.objectContaining({ path: '/_blocks/0/primary/label/en', value: 'Book' }),
    ]));
  });

  it('applies only existing scalar paths and protects structural block keys', () => {
    const original = page().lect;
    const form = new FormData();
    form.set('field:/_blocks/0/title/en', 'Updated title');
    form.set('field:/_blocks/0/_type', 'malicious-template');
    form.set('field:/_blocks/9/title/en', 'out of range');
    form.set('field:/__proto__/polluted', 'yes');
    const updated = applyEditorFields(original, form);
    const block = (updated._blocks as Array<Record<string, unknown>>)[0];
    expect((block.title as Record<string, unknown>).en).toBe('Updated title');
    expect(block._type).toBe('hero');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('theme editor routes', () => {
  it('loads every concrete readable type and returns the CMS client-view data', async () => {
    const fixture = page();
    const calls = mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      if (url.pathname === '/__cms/pages') {
        return { pages: url.searchParams.get('page_type') === 'home' ? [fixture] : [], total: 1 };
      }
      throw new Error(`Unexpected call ${url}`);
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/editor?page_id=12&language=en&block=0'),
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-cms-client-view')).toBe('1');
    expect(response.headers.get('x-cms-view-path')).toBe('/templates/editor.json');
    const data = await response.json() as Record<string, unknown>;
    expect((data.selectedPage as CmsPage).id).toBe(12);
    expect(data.selectedBlock).toBe(0);
    expect(data.previewHref).toContain('page_id=12');
    expect(data.previewHref).toContain('block=0');
    const html = await renderEditorSection(data);
    expect(html).toContain('Theme preview');
    expect(html).toContain('field:/_blocks/0/title/en');
    expect(html).toContain('Hello from the theme');
    expect(html).toContain('Save changes');

    const pageTypes = calls
      .filter((call) => call.url.pathname === '/__cms/pages')
      .map((call) => call.url.searchParams.get('page_type'));
    expect(pageTypes).toEqual(['home', 'site_settings', 'news']);
    expect(pageTypes).not.toContain('*');
  });

  it('renders the development Liquid theme with selectable block overlays', async () => {
    const fixture = page();
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      if (url.pathname === '/__cms/pages/12') return { page: fixture };
      if (url.pathname === '/__cms/pages') return { pages: [], total: 0 };
      throw new Error(`Unexpected call ${url}`);
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/preview?page_id=12&language=en&block=0'),
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-cms-frame')).toBe('1');
    const html = await response.text();
    expect(html).toContain('Hello from the theme');
    expect(html).toContain('theme-editor-block is-selected');
    expect(html).toContain('/admin/plugins/theme-editor/editor?page_id=12');
    expect(html).toContain('/admin/plugins/theme-editor/theme/assets/site.css');
    expect(html).not.toContain('href="/assets/site.css');
  });

  it('updates lect through the CMS API and attributes the mutation to the editor', async () => {
    const fixture = page();
    const calls = mockCms(({ method, url }) => {
      if (method === 'GET' && url.pathname === '/__cms/pages/12') return { page: fixture };
      if (method === 'PATCH' && url.pathname === '/__cms/pages/12') return { page: fixture };
      throw new Error(`Unexpected call ${method} ${url}`);
    });

    const body = new URLSearchParams({
      page_id: '12',
      language: 'en',
      block: '0',
      'field:/_blocks/0/title/en': 'Saved from the theme editor',
    });
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/save', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      }),
      env(),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('flash=Changes%20saved');

    const update = calls.find((call) => call.method === 'PATCH');
    expect(update?.headers.get('x-plugin-id')).toBe('theme-editor');
    expect(update?.headers.get('x-plugin-secret')).toBe(SECRET);
    expect(update?.headers.get('x-acting-user-id')).toBe('42');
    const lect = (update?.body as { lect: Record<string, unknown> }).lect;
    const block = (lect._blocks as Array<Record<string, unknown>>)[0];
    expect((block.title as Record<string, unknown>).en).toBe('Saved from the theme editor');
    expect(block._type).toBe('hero');
  });

  it('blocks mutations for a view-only user', async () => {
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/save', { method: 'POST' }, {
        id: '8',
        role: 'moderator',
        permissions: ['theme-editor:view'],
      }),
      env(),
    );
    expect(response.status).toBe(403);
  });
});
