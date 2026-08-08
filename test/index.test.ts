import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPluginStateCache, clearTenantCache, tenantRef, type CmsPage } from '@lionrockjs/worker-cms-plugin';
import { cmsState, themeOverridesKey } from './cms-state';
import { testLiquid } from './host-liquid';
import worker from '../src/index';
import { applyEditorFields, editorFields } from '../src/editor-model';
import {
  previewThemeStore,
  renderThemePreview,
  resolveThemeBinding,
  themeRuntime,
} from '../src/theme/renderer';
import { AssetThemeStore, type ThemeStore } from '../src/theme/store';
import {
  selectThemeTemplate,
  templatePageTypeResources,
  themeTemplates,
  type ThemeTemplate,
} from '../src/theme/templates';
import { availableThemes } from '../src/themes';
import type { PluginEnv, ThemePageResourceCollection } from '../src/types';

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

const CMS_ORIGIN = 'https://cms.example.com';

function env(overrides: Partial<PluginEnv> = {}): PluginEnv {
  return {
    VIEWS: views(),
    CMS_URL: CMS_ORIGIN,
    PLUGIN_SECRET: SECRET,
    THEME_ID: 'example-theme',
    THEME_NAME: 'Development theme',
    THEME_SITE_TITLE: 'Preview site',
    ...overrides,
  };
}

/**
 * Override keys are scoped by tenant ref, the same handle the plugin derives
 * from the authenticated tenant. Computed here rather than written out, so a
 * change to the derivation shows up as a failing assertion instead of fixtures
 * that quietly stop matching what the Worker reads.
 */
async function overrideKey(themeId: string, templateId: string): Promise<string> {
  return `sections:${await tenantRef(CMS_ORIGIN)}:${themeId}:${templateId}`;
}

/**
 * The preview frame is rendered in the browser, so the Worker no longer emits
 * that HTML. These exercise the shared renderer directly — it is the same
 * function the browser bundle imports, so what it produces here is what the
 * frame shows.
 */
async function renderPreview(
  fixture: CmsPage,
  options: {
    templateId?: string;
    selectedBlock?: number | null;
    hidden?: string[];
    news?: CmsPage[];
    pagesByType?: Record<string, ThemePageResourceCollection>;
    settingOverrides?: Record<string, Record<string, string>>;
    structure?: {
      order: string[];
      added: Record<string, { type: string }>;
      deleted: string[];
    };
  } = {},
): Promise<string> {
  const pluginEnv = env();
  const theme = (await availableThemes(pluginEnv))[0];
  const store = previewThemeStore(new AssetThemeStore(pluginEnv.VIEWS, theme.assetPrefix));
  const templates = await themeTemplates(pluginEnv, theme, store);
  const template = selectThemeTemplate(templates, options.templateId ?? 'page');
  if (!template) throw new Error('Theme template not found');
  const runtime = themeRuntime(pluginEnv, store, theme.id);
  return renderThemePreview(runtime, {
    page: fixture,
    settings: null,
    pages: [fixture],
    news: options.news ?? [],
    pagesByType: options.pagesByType ?? {},
    language: 'en',
    languages: ['en', 'zh-hant'],
    defaultLanguage: 'en',
    editorHref: `/admin/plugins/theme-editor/editor?theme=example-theme&template=${template.id}&page_id=${fixture.id}&language=en`,
    selectedBlock: options.selectedBlock === undefined ? 0 : options.selectedBlock,
  }, template, new Set(options.hidden ?? []), options.settingOverrides ?? {},
  options.structure ?? { order: [], added: {}, deleted: [] });
}

/** In-memory stand-in for the THEME_OVERRIDES namespace. */
function kv(seed: Record<string, string> = {}): KVNamespace & { store: Map<string, string> } {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

function tenantKv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async list({ prefix = '' }: { prefix?: string } = {}) {
      return {
        keys: [...store.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      };
    },
    async get(key: string, type?: string) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
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

/**
 * The host's plugin-state store, shared by every call in a test. The theme
 * editor keeps its override layer there, so a handler that only answers page
 * and content-meta calls would otherwise see requests it does not recognise.
 */
let state = cmsState();

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

    const hosted = state.handle(url, call.method, call.body);
    if (hosted) return hosted;

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
  return String(await testLiquid({ outputEscape: 'escape' }).parseAndRender(source, data));
}

async function renderThemesSection(data: Record<string, unknown>): Promise<string> {
  const source = await readFile(fileURLToPath(new URL('../views/sections/themes.liquid', import.meta.url)), 'utf8');
  return String(await testLiquid({ outputEscape: 'escape' }).parseAndRender(source, data));
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearTenantCache();
  clearPluginStateCache();
  state = cmsState();
});

describe('plugin contract', () => {
  it('declares admin-approved wildcard read and write scopes', async () => {
    const response = await plugin.fetch(new Request('https://plugin.example.com/__plugin/manifest'), env());
    expect(response.status).toBe(200);
    const manifest = await response.json() as {
      id: string;
      autoTenant: boolean;
      i18n: boolean;
      nav: Array<{ href: string }>;
      assets: Array<{ path: string }>;
      contentTypes: { readTypes: string[]; writeTypes: string[] };
    };
    expect(manifest.id).toBe('theme-editor');
    expect(manifest.autoTenant).toBe(true);
    expect(manifest.i18n).toBe(true);
    expect(manifest.nav[0]?.href).toBe('');
    expect(manifest.assets).toEqual([
      { path: '/assets/theme-editor.js', label: 'Theme editor local block composer' },
      { path: '/assets/theme-preview.js', label: 'Theme editor in-browser preview renderer' },
    ]);
    expect(manifest.contentTypes.readTypes).toEqual(['*']);
    expect(manifest.contentTypes.writeTypes).toEqual(['*']);
  });

  it('automatically enrolls and revokes a CMS tenant', async () => {
    const cmsOrigin = 'https://cms.example.com';
    const ticket = 't'.repeat(64);
    const secret = 's'.repeat(64);
    const tenants = tenantKv();
    const tenantEnv = env({
      CMS_URL: undefined,
      PLUGIN_SECRET: undefined,
      TENANTS: tenants,
    });

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`${cmsOrigin}/__cms/tenant/claim`);
      return Response.json({
        tenant: cmsOrigin,
        cms_url: cmsOrigin,
        plugin_id: 'theme-editor',
        secret,
      });
    }));

    const enrolled = await plugin.fetch(new Request('https://plugin.example.com/__plugin/tenants/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant: cmsOrigin, plugin_id: 'theme-editor', ticket }),
    }), tenantEnv);
    expect(enrolled.status).toBe(200);
    expect(tenants.store.has(`tenant:${cmsOrigin}`)).toBe(true);

    const revoked = await plugin.fetch(new Request('https://plugin.example.com/__plugin/tenants/revoke', {
      method: 'POST',
      headers: {
        'x-cms-tenant': cmsOrigin,
        'x-plugin-secret': secret,
      },
    }), tenantEnv);
    expect(revoked.status).toBe(200);
    expect(tenants.store.has(`tenant:${cmsOrigin}`)).toBe(false);
  });

  it('serves the approved focus asset at bare and admin-proxy paths', async () => {
    const bare = await plugin.fetch(
      new Request('https://plugin.example.com/assets/theme-editor.js'),
      env(),
    );
    expect(bare.status).toBe(200);
    const script = await bare.text();
    expect(script).toContain("JSON.parse(stateSource.value)");
    expect(script).toContain("function composePanel(block, section)");
    expect(script).toContain("function editorFields(lect, languages, language, blockIndex)");
    expect(script).toContain("if (readOnlyKey(key)) return");
    expect(script).toContain("selectedType:");
    expect(script).toContain("window.history.pushState");
    expect(script).toContain("preview.contentDocument");
    expect(script).toContain("[data-theme-editor-block]");
    expect(script).toContain("function isInteractiveTarget(target)");
    expect(script).toContain("focusTarget(null, '', editorHref(null, ''), true, 'list')");
    expect(script).toContain("function setInspectorView(view, animate, focusTarget)");
    expect(script).toContain("translateX(-50%)");
    expect(script).toContain("data-theme-editor-close");
    expect(script).toContain("window.fetch(form.action");
    expect(script).toContain("function reloadPreview()");
    expect(script).toContain("preview.contentWindow.location.reload()");
    expect(script).toContain("Discard unsaved changes in this selection?");
    expect(script).toContain("function setupPageCombobox(select, combobox)");
    expect(script).toContain("data-theme-editor-page-option");

    const proxied = await plugin.fetch(
      adminRequest('/__plugin/admin/assets/theme-editor.js'),
      env(),
    );
    expect(proxied.status).toBe(200);
  });

  it('serves only plugin client views from the public view resolver', async () => {
    const editor = await plugin.fetch(
      new Request('https://plugin.example.com/__plugin/views/templates/editor.json'),
      env(),
    );
    expect(editor.status).toBe(200);

    const themes = await plugin.fetch(
      new Request('https://plugin.example.com/__plugin/views/templates/themes.json'),
      env(),
    );
    expect(themes.status).toBe(200);

    const locale = await plugin.fetch(
      new Request('https://plugin.example.com/__plugin/views/locales/zh-hant.json'),
      env(),
    );
    expect(locale.status).toBe(200);
    expect(await locale.json()).toMatchObject({
      plugins: { 'theme-editor': { nav: { index: '主題編輯器' } } },
    });

    const themeSource = await plugin.fetch(
      new Request('https://plugin.example.com/__plugin/views/theme/templates/page.liquid'),
      env(),
    );
    expect(themeSource.status).toBe(404);
  });

  it('renders translated theme labels through the client-view filter', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../views/sections/themes.liquid', import.meta.url)),
      'utf8',
    );
    const html = String(await testLiquid(
      { outputEscape: 'escape' },
      {
        'plugins.theme-editor.themes.title': '主題',
        'plugins.theme-editor.themes.description': '選擇主題',
        'plugins.theme-editor.themes.empty': '沒有可用的主題。',
      },
    ).parseAndRender(source, {
      title: 'Themes',
      description: 'Choose a theme',
      canEdit: false,
      themes: [],
    }));
    expect(html).toContain('>主題<');
    expect(html).toContain('>選擇主題<');
    expect(html).toContain('>沒有可用的主題。<');
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
      expect.objectContaining({ path: '/_blocks/0/theme', value: 'cream', kind: 'attribute' }),
      expect.objectContaining({ path: '/_blocks/0/title/en', value: 'Hello from the theme', kind: 'localized' }),
      expect.objectContaining({ path: '/_blocks/0/primary/label/en', value: 'Book' }),
    ]));
    const blockPaths = blockValues.map((field) => field.path);
    expect(blockPaths).not.toContain('/_blocks/0/_id');
    expect(blockPaths).not.toContain('/_blocks/0/_type');
    expect(blockPaths).not.toContain('/_blocks/0/_weight');
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

describe('template page resources', () => {
  const template: ThemeTemplate = {
    id: 'resource-page',
    label: 'Resource page',
    path: '/templates/resource-page.json',
    format: 'json',
  };

  function resourceStore(definition: unknown): ThemeStore {
    return {
      read: async () => JSON.stringify(definition),
      exists: async () => true,
    };
  }

  it('turns pages_by_type declarations into one bounded query plan', async () => {
    await expect(templatePageTypeResources(template, resourceStore({
      resources: {
        pages_by_type: {
          service: { limit: 60, sort: 'weight', order: 'asc' },
          team_member: {
            limit: 40,
            sort: 'name',
            order: 'asc',
            group_by: { tag_taxonomy: 'categories', include_untagged: true },
          },
          news: { limit: 6, sort: 'published_at', order: 'desc' },
        },
      },
    }))).resolves.toEqual([
      { key: 'service', page_type: 'service', limit: 60, sort: 'weight', order: 'asc' },
      {
        key: 'team_member', page_type: 'team_member', limit: 40, sort: 'name', order: 'asc',
        group_by: { tag_taxonomy: 'categories', include_untagged: true },
      },
      { key: 'news', page_type: 'news', limit: 6, sort: 'published_at', order: 'desc' },
    ]);
  });

  it('rejects unsafe, unbounded, and unknown query values', async () => {
    await expect(templatePageTypeResources(template, resourceStore({
      resources: {
        pages_by_type: {
          '../service': { limit: 60, sort: 'weight', order: 'asc' },
        },
      },
    }))).rejects.toThrow('Invalid pages_by_type resource');

    await expect(templatePageTypeResources(template, resourceStore({
      resources: {
        pages_by_type: {
          service: { limit: 501, sort: 'random()', order: 'sideways' },
        },
      },
    }))).rejects.toThrow('Invalid pages_by_type resource');
  });

  it('projects resource pages and localized tag groups into Liquid', async () => {
    const fixture = page();
    const service = page({
      id: 31,
      page_type: 'service',
      name: 'Personal colour',
      slug: 'personal-colour',
      lect: { title: { en: 'Personal colour consultation' } },
    });
    const runtime = themeRuntime(env(), resourceStore({}), 'resource-theme');
    const html = await resolveThemeBinding(runtime, {
      page: fixture,
      settings: null,
      pages: [fixture],
      news: [],
      pagesByType: {
        service: {
          pages: [service],
          groups: [{
            tag: {
              id: 7,
              slug: 'colour',
              name: 'Colour',
              weight: 10,
              taxonomy_slug: 'categories',
              parent_tag: null,
              created_at: '2026-01-01',
              updated_at: '2026-01-01',
              lect: { name: { en: 'Colour analysis' } },
            },
            pages: [service],
          }],
        },
      },
      language: 'en',
      languages: ['en', 'zh-hant'],
      defaultLanguage: 'en',
      editorHref: '/editor',
      selectedBlock: null,
    }, "{{ pages_by_type['service'].pages[0].name }}|{{ pages_by_type['service'].groups[0].name }}|{{ pages_by_type['service'].groups[0].pages[0].name }}");

    expect(html).toBe('Personal colour consultation|Colour analysis|Personal colour consultation');
  });
});

describe('theme editor routes', () => {
  it('lists available themes at the plugin dashboard', async () => {
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin'),
      env(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-cms-client-view')).toBe('1');
    expect(response.headers.get('x-cms-view-path')).toBe('/templates/themes.json');
    const data = await response.json() as {
      title: string;
      themes: Array<{
        id: string;
        name: string;
        editorHref: string;
      }>;
    };
    expect(data.title).toBe('Themes');
    expect(data.themes).toEqual([
      expect.objectContaining({
        id: 'example-theme',
        name: 'Development theme',
        editorHref: '/admin/plugins/theme-editor/editor?theme=example-theme',
      }),
    ]);
    const html = await renderThemesSection(data as unknown as Record<string, unknown>);
    expect(html).toContain('Development theme');
    expect(html).toContain('Local .dist/views/theme');
    expect(html).toContain('Edit theme');
    // An asset-bundle theme belongs to a deploy, so the editor offers no way
    // to remove it.
    expect(html).not.toContain('Delete theme');
  });

  it('offers deleting a bucket theme behind a typed confirmation', async () => {
    const withRepo = await renderThemesSection({
      canEdit: true,
      deleteAction: '/admin/plugins/theme-editor/delete',
      themes: [{
        id: 'website',
        name: 'Website',
        source: 'Example-Org/website@main',
        status: 'GitHub',
        editorHref: '/admin/plugins/theme-editor/editor?theme=website',
        canDelete: true,
        repo: { owner: 'Example-Org', repo: 'website', branch: 'main', path: '' },
      }],
    });
    expect(withRepo).toContain('action="/admin/plugins/theme-editor/delete"');
    expect(withRepo).toContain('name="confirm_id"');
    expect(withRepo).toContain('data-confirm');
    // A theme that came from a repository can be cloned again; the dialog says
    // so rather than implying the files are the only copy.
    expect(withRepo).toContain('can be cloned again');

    const bucketOnly = await renderThemesSection({
      canEdit: true,
      deleteAction: '/admin/plugins/theme-editor/delete',
      themes: [{
        id: 'local-theme',
        name: 'Local Theme',
        source: 'Bucket local-theme/',
        status: 'Bucket',
        editorHref: '/admin/plugins/theme-editor/editor?theme=local-theme',
        canDelete: true,
        repo: null,
      }],
    });
    expect(bucketOnly).toContain('no repository to clone it back from');

    // A read-only user is not shown a destructive action they cannot take.
    const readOnly = await renderThemesSection({
      canEdit: false,
      deleteAction: '/admin/plugins/theme-editor/delete',
      themes: [{ id: 'website', name: 'Website', canDelete: true, editorHref: '#' }],
    });
    expect(readOnly).not.toContain('Delete theme');
  });

  it('does not open a theme that is not in the registry', async () => {
    const editorResponse = await plugin.fetch(
      adminRequest('/__plugin/admin/editor?theme=missing'),
      env(),
    );
    expect(editorResponse.status).toBe(302);
    expect(editorResponse.headers.get('location')).toBe('/admin/plugins/theme-editor');

    const previewResponse = await plugin.fetch(
      adminRequest('/__plugin/admin/preview?theme=missing&page_id=12'),
      env(),
    );
    expect(previewResponse.status).toBe(404);
  });

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
      adminRequest('/__plugin/admin/editor?theme=example-theme&page_id=12&language=en&block=0'),
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-cms-client-view')).toBe('1');
    expect(response.headers.get('x-cms-view-path')).toBe('/templates/editor.json');
    const data = await response.json() as Record<string, unknown>;
    expect((data.selectedPage as CmsPage).id).toBe(12);
    expect(data.selectedBlock).toBe(0);
    expect(data.selectedType).toBe('hero');
    expect(data.themeId).toBe('example-theme');
    expect(data.templateId).toBe('page');
    // The theme owns its template inventory, so assert the selection contract
    // rather than a snapshot of whichever templates the theme ships today.
    expect(data.templates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'message', label: 'Message', selected: false }),
      expect.objectContaining({ id: 'news-article', label: 'News Article', selected: false }),
      expect.objectContaining({ id: 'news-index', label: 'News Index', selected: false }),
      expect.objectContaining({ id: 'page', label: 'Page', selected: true }),
    ]));
    const selectedTemplates = (data.templates as Array<{ selected: boolean }>)
      .filter((template) => template.selected);
    expect(selectedTemplates).toHaveLength(1);
    expect(data.previewHref).toContain('page_id=12');
    expect(data.previewHref).toContain('theme=example-theme');
    expect(data.previewHref).toContain('template=page');
    expect(data.previewHref).toContain('block=0');
    const editorState = JSON.parse(String(data.editorStateJson)) as {
      pageId: number;
      themeId: string;
      templateId: string;
      lect: Record<string, unknown>;
      languages: string[];
      language: string;
    };
    expect(editorState.pageId).toBe(12);
    expect(editorState.themeId).toBe('example-theme');
    expect(editorState.templateId).toBe('page');
    expect(editorState.lect).toEqual(fixture.lect);
    expect(editorState.languages).toEqual(['en', 'zh-hant']);
    expect(editorState.language).toBe('en');
    const html = await renderEditorSection(data);
    expect(html).toContain('Theme preview');
    expect(html).toContain('field:/_blocks/0/title/en');
    expect(html).toContain('Hello from the theme');
    expect(html).toContain('data-theme-editor-selected-type');
    expect(html).toContain('data-theme-editor-panel-viewport');
    expect(html).toContain('data-theme-editor-panel-track');
    expect(html).toContain('data-theme-editor-list-panel');
    expect(html).toContain('data-theme-editor-settings-panel');
    expect(html).toContain('data-theme-editor-close');
    expect(html).toContain('data-theme-editor-save-button');
    expect(html).toContain('data-theme-editor-save-status');
    expect(html).toContain('aria-label="Close settings"');
    expect(html).toContain('>hero</span>');
    expect(html).not.toContain('name="field:/_blocks/0/_id"');
    expect(html).not.toContain('name="field:/_blocks/0/_type"');
    expect(html).not.toContain('name="field:/_blocks/0/_weight"');
    expect(html).toContain('Save changes');
    expect(html).toContain('data-theme-editor-focus');
    expect(html).toContain('data-theme-editor-state');
    expect(html).toContain('data-editor-action="/admin/plugins/theme-editor/editor"');
    expect(html).toContain('name="theme" value="example-theme"');
    expect(html).toContain('name="template"');
    expect(html).toContain('data-theme-editor-page-combobox');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('placeholder="Search pages by name, type, or id"');
    expect(html).toContain('<option value="news-index">News Index</option>');
    expect(html).toContain('<option value="page" selected>Page</option>');
    expect(html).toContain('href="/admin/plugins/theme-editor"');
    expect(html).toContain('&lt;p&gt;Editable copy.&lt;/p&gt;');
    expect(html).toContain('/admin/plugins/theme-editor/assets/theme-editor.js');

    const pageTypes = calls
      .filter((call) => call.url.pathname === '/__cms/pages')
      .map((call) => call.url.searchParams.get('page_type'));
    expect(pageTypes).toEqual(['home', 'site_settings', 'news']);
    expect(pageTypes).not.toContain('*');
  });

  it('renders the development Liquid theme with selectable block overlays', async () => {
    const html = await renderPreview(page());
    expect(html).toContain('Hello from the theme');
    expect(html).toContain('class="hero hero--cream');
    expect(html).toContain('href="/book"');
    expect(html).toContain('>Book</a>');
    expect(html).not.toContain('{% schema %}');
    expect(html).toContain('theme-editor-block is-selected');
    expect(html).toContain('data-theme-editor-block="0"');
    expect(html).toContain('data-theme-editor-field="field:/_blocks/0/title/en"');
    expect(html).toContain('data-theme-editor-field="field:/_blocks/0/primary/label/en"');
    // Rich HTML is not reversible through a plaintext contenteditable, so the
    // compiler deliberately leaves this opt-in marker inert.
    expect(html).toContain('<div data-theme-editor-field=""><p>Editable copy.</p></div>');
    expect(html).toContain('/admin/plugins/theme-editor/editor?theme=example-theme&amp;template=page&amp;page_id=12');
    expect(html).toContain('/admin/plugins/theme-editor/theme/assets/site.css?theme=example-theme&v=');
    expect(html).not.toContain('href="/assets/site.css');
  });

  it('automatically annotates direct text in shared headings and repeated section blocks', async () => {
    const fixture = page();
    const blocks = fixture.lect._blocks as Array<Record<string, unknown>>;
    blocks.push({
      _id: 'features-1',
      _type: 'features',
      _weight: 20,
      eyebrow: { en: 'Why us' },
      title: { en: 'Automatically editable' },
      body: { en: '<p>Rich introduction.</p>' },
      features: [{
        name: { en: 'Direct item name' },
        description: { en: 'Direct item description' },
      }],
    });

    const html = await renderPreview(fixture);
    expect(html).toContain(
      '<p data-theme-editor-field="field:/_blocks/1/eyebrow/en">Why us</p>',
    );
    expect(html).toContain(
      '<h2 data-theme-editor-field="field:/_blocks/1/title/en">Automatically editable</h2>',
    );
    expect(html).toContain(
      '<h3 data-theme-editor-field="field:/_blocks/1/features/0/name/en">Direct item name</h3>',
    );
    expect(html).toContain(
      '<p data-theme-editor-field="field:/_blocks/1/features/0/description/en">Direct item description</p>',
    );
    expect(html).toContain('<div><p>Rich introduction.</p></div>');
    expect(html).not.toContain('data-theme-editor-field="field:/_blocks/1/body/en"');
  });

  it('serves an empty frame that loads its own data and templates', async () => {
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/preview?theme=example-theme&template=page&page_id=12&language=en&block=0'),
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-cms-frame')).toBe('1');
    const html = await response.text();

    // The frame renders nothing and carries no script: the host strips every
    // `<script>` from a plugin HTML document, so one shipped here could never
    // run. The editor page renders into this frame instead.
    expect(html).not.toContain('class="hero');
    expect(html).not.toContain('<script');
    expect(html).toContain('/admin/plugins/theme-editor/theme/assets/site.css?theme=example-theme');
    expect(html).toContain('data-theme-preview-status');
  });

  it('drives block settings from the section schema and shows their bindings', async () => {
    const fixture = page({
      lect: {
        _type: 'home',
        _blocks: [
          {
            _id: 'hero-1',
            _type: 'hero',
            _weight: 10,
            theme: 'cream',
            anchor: 'top',
            align: 'left',
            eyebrow: { en: 'Studio' },
            title: { en: 'Hello from the theme' },
            body: { en: '<p>Editable copy.</p>' },
            picture: 'hero.jpg',
            picture_alt: { en: 'Alt' },
            primary: { label: { en: 'Book' }, url: { en: '/book' } },
            secondary: { label: { en: 'More' }, url: { en: '/more' } },
          },
        ],
      },
    });
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      if (url.pathname === '/__cms/pages') {
        return { pages: url.searchParams.get('page_type') === 'home' ? [fixture] : [], total: 1 };
      }
      throw new Error(`Unexpected call ${url}`);
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/editor?theme=example-theme&template=page&page_id=12&language=en&block=0&settings=schema'),
      env(),
    );
    const data = await response.json() as Record<string, unknown>;
    const settings = data.schemaSettings as Array<{
      id: string; label: string; type: string; binding: string; value: string;
      editable: boolean; hasOptions: boolean; inputName: string;
    }>;

    expect(data.schemaMode).toBe(true);
    expect(data.schemaName).toBe('Hero');
    // Order, labels, and control types come from the section's own schema.
    expect(settings.map((setting) => setting.id)).toEqual([
      'theme', 'anchor', 'align', 'eyebrow', 'title', 'bodyHtml',
      'primary_label', 'primary_url', 'secondary_label', 'secondary_url',
      'picture', 'pictureAlt',
    ]);
    expect(settings[0]).toMatchObject({ label: 'Theme', type: 'select', hasOptions: true });

    // The binding is the Liquid a JSON template writes to read this setting.
    expect(settings[0].binding).toBe('{{ page.blocks[0].theme }}');
    expect(settings.find((setting) => setting.id === 'bodyHtml')?.binding)
      .toBe('{{ page.blocks[0].bodyHtml }}');

    // Saving writes the binding into the template, so the inputs are named for
    // the setting, not for the lect path the value happens to live at.
    expect(settings.find((setting) => setting.id === 'bodyHtml')?.inputName).toBe('setting:bodyHtml');
    expect(data.schemaSection).toBe('hero');
    expect(data.schemaAction).toBe('/admin/plugins/theme-editor/template-settings');

    // Every declared setting still resolves to a real lect field, which is what
    // gives the binding a resolved value to show underneath it.
    expect(settings.every((setting) => setting.editable)).toBe(true);
    expect(settings.find((setting) => setting.id === 'theme')?.value).toBe('cream');
    expect(settings.find((setting) => setting.id === 'eyebrow')?.value).toBe('Studio');

    const html = await renderEditorSection(data);
    expect(html).toContain('>Schema<');
    expect(html).toContain('data-settings-mode="schema"');

    // The control holds the binding — what a save writes into the template —
    // and the value it resolves to is the hint beneath it.
    expect(html).toContain('name="setting:eyebrow" value="{{ page.blocks[0].eyebrow }}"');
    expect(html).toContain('name="setting:bodyHtml" value="{{ page.blocks[0].bodyHtml }}"');
    // First paint of the hint is the stored value; the editor page replaces it
    // with what the binding resolves to once the renderer is up.
    const eyebrow = html.slice(html.indexOf('name="setting:eyebrow"'));
    expect(eyebrow.slice(0, 900)).toContain('data-theme-editor-setting-value');
    expect(eyebrow.slice(0, 900)).toContain('Studio');

    // The schema panel writes template bindings, never lect paths.
    const schemaPanel = html.slice(
      html.indexOf('data-theme-editor-panel="schema"'),
      html.indexOf('data-theme-editor-panel="values"'),
    );
    expect(schemaPanel).not.toContain('name="field:/');
    expect(html).toContain('action="/admin/plugins/theme-editor/template-settings"');
    // Page values are still edited in the values panel.
    expect(html).toContain('name="field:/_blocks/0/body/en"');
  });

  it('serves one section\'s bindings on their own, so the editor need not reload', async () => {
    // The browser cannot compose this panel: the bindings come from the
    // theme's own {% schema %}. Without this endpoint, switching to Schema or
    // moving between sections while in it could only be done by loading the
    // whole editor again, throwing away the client-side selection.
    const fixture = page({
      lect: {
        _type: 'home',
        _blocks: [{ _id: 'hero-1', _type: 'hero', _weight: 10, theme: 'cream', title: { en: 'Hello' } }],
      },
    });
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      if (url.pathname === '/__cms/pages/12') return { page: fixture };
      if (url.pathname === '/__cms/pages') {
        return { pages: url.searchParams.get('page_type') === 'home' ? [fixture] : [], total: 1 };
      }
      throw new Error(`Unexpected call ${url}`);
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/section-schema?theme=example-theme&template=page'
        + '&page_id=12&language=en&section=hero&block=0'),
      env(),
    );
    expect(response.status).toBe(200);
    const data = await response.json() as {
      ok: boolean; section: string; block: number | null; schemaName: string;
      missingBlock: boolean; canEditSchema: boolean;
      schemaSettings: Array<{ id: string; binding: string; value: string; inputName: string }>;
    };

    // Identical in shape to what the page is rendered from, so the client
    // draws the same panel the server would have.
    expect(data).toMatchObject({ ok: true, section: 'hero', block: 0, schemaName: 'Hero', missingBlock: false });
    expect(data.schemaSettings[0]).toMatchObject({
      id: 'theme',
      binding: '{{ page.blocks[0].theme }}',
      inputName: 'setting:theme',
      value: 'cream',
    });

    // A section the page carries no block for still has bindings — that is the
    // case that opens on this panel rather than on an empty values form.
    const noBlock = await plugin.fetch(
      adminRequest('/__plugin/admin/section-schema?theme=example-theme&template=page'
        + '&page_id=12&language=en&section=cta'),
      env(),
    );
    expect(await noBlock.json()).toMatchObject({ ok: true, section: 'cta', missingBlock: true });

    // A section the template does not declare is refused rather than answered
    // with an empty panel that would look like a section with no settings.
    const unknown = await plugin.fetch(
      adminRequest('/__plugin/admin/section-schema?theme=example-theme&template=page'
        + '&page_id=12&language=en&section=not-a-section'),
      env(),
    );
    expect(unknown.status).toBe(404);
  });

  it('leaves the values mode untouched when no schema is asked for', async () => {
    const fixture = page();
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      if (url.pathname === '/__cms/pages') {
        return { pages: url.searchParams.get('page_type') === 'home' ? [fixture] : [], total: 1 };
      }
      throw new Error(`Unexpected call ${url}`);
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/editor?theme=example-theme&template=page&page_id=12&language=en&block=0'),
      env(),
    );
    const data = await response.json() as Record<string, unknown>;
    expect(data.schemaMode).toBe(false);
    expect(data.schemaModeHref).toContain('settings=schema');
    expect(data.valuesModeHref).not.toContain('settings=schema');
    // Both panels are built whichever mode is asked for, so switching between
    // them needs no page load.
    expect((data.schemaSettings as unknown[]).length).toBeGreaterThan(0);
    expect(data.schemaBlock).toBe('0');

    const html = await renderEditorSection(data);
    expect(html).toContain('data-settings-mode="values"');
    expect(html).toContain('name="field:/_blocks/0/title/en"');

    // The inactive panel is disabled, so its inputs cannot compete with the
    // visible panel's for the same lect paths on save.
    const schemaPanel = html.slice(html.indexOf('data-theme-editor-panel="schema"'));
    expect(schemaPanel.slice(0, 120)).toContain('disabled');
    expect(schemaPanel.slice(0, 120)).toContain('hidden');
    const valuesPanel = html.slice(html.indexOf('data-theme-editor-panel="values"'));
    expect(valuesPanel.slice(0, 120)).not.toContain('disabled');
  });

  it('saves a schema setting as the template binding and renders through it', async () => {
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      throw new Error(`Unexpected call ${url}`);
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/template-settings', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          theme: 'example-theme',
          template: 'page',
          section: 'hero',
          'setting:title': '{{ page.blocks[0].eyebrow }}',
          'setting:eyebrow': '',
          'setting:nonsense': 'ignored',
        }),
      }),
      env(),
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      settings: Record<string, string>;
      settingOverrides: Record<string, Record<string, string>>;
    };

    // A binding cleared to nothing is the template no longer setting it, and a
    // setting the section's schema does not declare is refused outright.
    expect(payload.settings).toEqual({ title: '{{ page.blocks[0].eyebrow }}' });
    expect(payload.settings.nonsense).toBeUndefined();
    expect(payload.settingOverrides.hero).toEqual({ title: '{{ page.blocks[0].eyebrow }}' });

    // Submitting a binding the theme already declares stores nothing, so a
    // later edit to the theme's own template is not masked by an override
    // repeating what it used to say.
    const unchanged = await plugin.fetch(
      adminRequest('/__plugin/admin/template-settings', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          theme: 'example-theme',
          template: 'page',
          section: 'hero',
          'setting:title': '{{ page.blocks[0].title }}',
          'setting:theme': '{{ page.blocks[0].theme }}',
        }),
      }),
      env(),
    );
    expect((await unchanged.json() as { settings: unknown }).settings).toEqual({});

    // The override is what the preview compiles: the hero title now renders the
    // block's eyebrow, because that is what the template binds.
    const fixture = page({
      lect: {
        _type: 'home',
        _blocks: [{
          _id: 'hero-1',
          _type: 'hero',
          _weight: 10,
          theme: 'cream',
          eyebrow: { en: 'Bound through the template' },
          title: { en: 'Original title' },
        }],
      },
    });
    const html = await renderPreview(fixture, { settingOverrides: payload.settingOverrides });
    expect(html).toContain('Bound through the template');
    expect(html).not.toContain('Original title');
  });

  it('exposes the override layer for the tooling that writes the theme', async () => {
    // The override layer lives on the CMS, so these need its stub installed
    // even though they ask it nothing else.
    mockCms(({ url }) => {
      throw new Error(`Unexpected call ${url}`);
    });
    // One key holds every template's overrides for a theme, so reading them
    // all is a point read rather than a scan.
    state = cmsState({
      [themeOverridesKey('example-theme')]: {
        page: {
          hidden: ['cta'],
          settings: { hero: { title: '{{ page.blocks[0].eyebrow }}' } },
        },
        // A template with nothing overridden is left out entirely, so the
        // writer has no reason to touch its file.
        message: { hidden: [], settings: {} },
      },
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/overrides?theme=example-theme'),
      env(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      theme: 'example-theme',
      templates: {
        page: {
          hidden: ['cta'],
          settings: { hero: { title: '{{ page.blocks[0].eyebrow }}' } },
          order: [],
          added: {},
          deleted: [],
        },
      },
    });

    // Cleared once written into the theme, so the file is the only thing left
    // saying what it says.
    const cleared = await plugin.fetch(
      adminRequest('/__plugin/admin/overrides/clear?theme=example-theme', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ template: 'page' }),
      }),
      env(),
    );
    expect(await cleared.json()).toMatchObject({ ok: true, template: 'page' });
    // Nothing left to say, so the key goes rather than lingering as an empty
    // record against the per-plugin key budget.
    expect(state.store.has(themeOverridesKey('example-theme'))).toBe(false);
  });

  it('adopts pending edits left in the pre-migration namespace', async () => {
    // Installs predating the move to the host keep their edits: the first read
    // collapses them into the host's single per-theme record and drains the
    // namespace, so it can be unbound once empty.
    mockCms(({ url }) => {
      throw new Error(`Unexpected call ${url}`);
    });
    const legacy = kv({
      [await overrideKey('example-theme', 'page')]: JSON.stringify({
        hidden: ['cta'],
        settings: {},
      }),
      [await overrideKey('example-theme', 'message')]: JSON.stringify({
        hidden: [],
        settings: { hero: { title: '{{ page.title }}' } },
      }),
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/overrides?theme=example-theme'),
      env({ THEME_OVERRIDES: legacy }),
    );
    expect(await response.json()).toMatchObject({
      templates: {
        page: { hidden: ['cta'] },
        message: { settings: { hero: { title: '{{ page.title }}' } } },
      },
    });

    // Both templates now live under one key, and the old entries are gone.
    expect(JSON.parse(state.store.get(themeOverridesKey('example-theme')) as string))
      .toEqual({
        page: { hidden: ['cta'], settings: {} },
        message: { hidden: [], settings: { hero: { title: '{{ page.title }}' } } },
      });
    expect(legacy.store.size).toBe(0);
  });

  it('keeps pending edits when the host will not take the migration', async () => {
    // The edits still exist and must stay usable; a failed hand-over leaves
    // them where they are rather than dropping them between the two stores.
    mockCms(({ url }) => {
      throw new Error(`Unexpected call ${url}`);
    });
    state.handle = (url: URL, method: string) => {
      if (!url.pathname.startsWith('/__cms/state')) return null;
      return method === 'GET'
        ? Response.json({ error: 'not_found' }, { status: 404 })
        : Response.json({ error: 'unavailable' }, { status: 503 });
    };
    const key = await overrideKey('example-theme', 'page');
    const legacy = kv({ [key]: JSON.stringify({ hidden: ['cta'], settings: {} }) });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/overrides?theme=example-theme'),
      env({ THEME_OVERRIDES: legacy }),
    );
    expect(await response.json()).toMatchObject({ templates: { page: { hidden: ['cta'] } } });
    expect(legacy.store.has(key)).toBe(true);
  });

  it('refuses to clear a template the theme does not have', async () => {
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/overrides/clear?theme=example-theme', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ template: 'not-a-template' }),
      }),
      env(),
    );
    expect(response.status).toBe(404);
  });

  it('denies clearing overrides without write access', async () => {
    const response = await plugin.fetch(
      adminRequest(
        '/__plugin/admin/overrides/clear?theme=example-theme',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ template: 'page' }),
        },
        { id: '42', role: 'viewer', permissions: ['theme-editor:view'] },
      ),
      env(),
    );
    expect(response.status).toBe(403);
  });

  it('offers a show/hide control per template section in the list', async () => {
    const fixture = page();
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      if (url.pathname === '/__cms/pages') {
        return { pages: url.searchParams.get('page_type') === 'home' ? [fixture] : [], total: 1 };
      }
      throw new Error(`Unexpected call ${url}`);
    });
    state = cmsState({
      [themeOverridesKey('example-theme')]: { page: { hidden: ['hero'], settings: {} } },
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/editor?theme=example-theme&template=page&page_id=12&language=en'),
      env(),
    );
    expect(response.status).toBe(200);
    const data = await response.json() as Record<string, unknown>;

    // The hero section binds to `page.blocks[0]`, so its row carries both that
    // block's values and the toggle for the section reading them.
    const sections = data.sections as Array<{
      key: string; hidden: boolean; hasBlock: boolean; blockIndex: number | null;
    }>;
    expect(sections[0]).toMatchObject({ key: 'hero', hidden: true, hasBlock: true, blockIndex: 0 });
    expect(data.visibilityAction).toBe('/admin/plugins/theme-editor/visibility');

    const html = await renderEditorSection(data);
    expect(html).toContain('action="/admin/plugins/theme-editor/visibility"');
    expect(html).toContain('name="section" value="hero"');
    // Hidden sections stay listed, offering the way back.
    expect(html).toContain('>Show<');
    expect(html).toContain('· hidden');
  });

  it('offers Publish only while there is something unpublished to publish', async () => {
    // An asset-bundle theme cannot be written at runtime, so it never offers
    // the button — `npm run theme:apply` does that job where it is checked out.
    const withPending = await renderEditorSection({
      canPublish: true,
      hasPending: true,
      pendingTemplates: 2,
      publishAction: '/admin/plugins/theme-editor/publish',
      themeId: 'website',
      publishTarget: 'Example-Org/website@main',
    });
    expect(withPending).toContain('action="/admin/plugins/theme-editor/publish"');
    expect(withPending).toContain('Publish &amp; push');
    // The button names where the commit lands, so it is not a surprise.
    expect(withPending).toContain('Example-Org/website@main');
    expect(withPending).toContain('data-confirm');

    // A bucket theme with no repository publishes, but pushes nowhere.
    const bucketOnly = await renderEditorSection({
      canPublish: true,
      hasPending: true,
      pendingTemplates: 1,
      publishAction: '/admin/plugins/theme-editor/publish',
      themeId: 'local',
      publishTarget: '',
    });
    expect(bucketOnly).toContain('action="/admin/plugins/theme-editor/publish"');
    expect(bucketOnly).toContain('Publish to the theme bucket');
    expect(bucketOnly).not.toContain('push');

    const nothingPending = await renderEditorSection({
      canPublish: true,
      hasPending: false,
      pendingTemplates: 0,
      publishAction: '/admin/plugins/theme-editor/publish',
    });
    expect(nothingPending).toContain('action="/admin/plugins/theme-editor/publish"');
    expect(nothingPending).toContain('data-theme-editor-publish hidden');
  });

  it('lists every section the template declares, not only the ones the page has blocks for', async () => {
    // The fixture page carries a single block, while `page.json` declares nine
    // sections reading `page.blocks[0]` through `[8]`. The list describes the
    // template, so the eight the page has no block for are still on it.
    const fixture = page();
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      if (url.pathname === '/__cms/pages') {
        return { pages: url.searchParams.get('page_type') === 'home' ? [fixture] : [], total: 1 };
      }
      throw new Error(`Unexpected call ${url}`);
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/editor?theme=example-theme&template=page&page_id=12&language=en'),
      env(),
    );
    const data = await response.json() as Record<string, unknown>;
    const sections = data.sections as Array<{ key: string; hasBlock: boolean; href: string }>;
    expect(sections.map((entry) => entry.key)).toEqual([
      'hero', 'features', 'services', 'steps', 'team', 'faq', 'news', 'contact', 'cta',
    ]);
    expect(sections.filter((entry) => entry.hasBlock).map((entry) => entry.key)).toEqual(['hero']);
    expect(sections[0].href).toContain('section=hero');
    expect(sections[0].href).toContain('block=0');
    expect(sections[1].href).toContain('section=features');
    expect(sections[1].href).not.toContain('block=');
    expect(data.sectionTypes).toEqual(expect.arrayContaining([
      { type: 'hero', label: 'Hero' },
      { type: 'cta', label: 'Cta' },
    ]));

    const html = await renderEditorSection(data);
    expect(html).toContain('Template sections');
    expect(html).toContain('action="/admin/plugins/theme-editor/section-add"');
    expect(html).toContain('action="/admin/plugins/theme-editor/section-delete"');
    expect(html).toContain('aria-label="Delete the Cta section"');
    expect(html).toContain('data-theme-editor-drag-handle');
    expect(html).toContain('data-section="cta"');
    expect(html).toContain('name="section" value="contact"');
    expect(html).toContain('· no page block');
  });

  it('stores a dragged section order and uses it for the editor and preview', async () => {
    const fixture = page();
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      if (url.pathname === '/__cms/pages') {
        return { pages: url.searchParams.get('page_type') === 'home' ? [fixture] : [], total: 1 };
      }
      if (url.pathname === '/__cms/pages/12') return { page: fixture };
      throw new Error(`Unexpected call ${url}`);
    });
    const order = ['cta', 'hero', 'features', 'services', 'steps', 'team', 'faq', 'news', 'contact'];

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/section-order', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          theme: 'example-theme', template: 'page', order: JSON.stringify(order),
        }),
      }),
      env(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, order });
    expect(JSON.parse(state.store.get(themeOverridesKey('example-theme')) as string))
      .toEqual({ page: { hidden: [], settings: {}, order } });

    const editor = await plugin.fetch(
      adminRequest('/__plugin/admin/editor?theme=example-theme&template=page&page_id=12&language=en'),
      env(),
    );
    const data = await editor.json() as { sections: Array<{ key: string }> };
    expect(data.sections.map((entry) => entry.key)).toEqual(order);

    const preview = await plugin.fetch(
      adminRequest('/__plugin/admin/preview/data?theme=example-theme&template=page&page_id=12&language=en'),
      env(),
    );
    expect((await preview.json() as { structure: { order: string[] } }).structure.order).toEqual(order);
  });

  it('adds a section type discovered from the theme sections folder', async () => {
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      throw new Error(`Unexpected call ${url}`);
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/section-add', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ theme: 'example-theme', template: 'page', type: 'hero' }),
      }),
      env(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, key: 'hero-2', type: 'hero' });
    const stored = JSON.parse(state.store.get(themeOverridesKey('example-theme')) as string);
    expect(stored.page.added).toEqual({ 'hero-2': { type: 'hero' } });
    expect(stored.page.order.at(-1)).toBe('hero-2');
  });

  it('deletes a section from the pending template, preview, and published JSON structure', async () => {
    const fixture = page();
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      if (url.pathname === '/__cms/pages') {
        return { pages: url.searchParams.get('page_type') === 'home' ? [fixture] : [], total: 1 };
      }
      if (url.pathname === '/__cms/pages/12') return { page: fixture };
      throw new Error(`Unexpected call ${url}`);
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/section-delete', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ theme: 'example-theme', template: 'page', section: 'cta' }),
      }),
      env(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, key: 'cta', deleted: ['cta'] });
    expect(JSON.parse(state.store.get(themeOverridesKey('example-theme')) as string))
      .toEqual({ page: { hidden: [], settings: {}, deleted: ['cta'] } });

    const editor = await plugin.fetch(
      adminRequest('/__plugin/admin/editor?theme=example-theme&template=page&page_id=12&language=en'),
      env(),
    );
    const editorData = await editor.json() as { sections: Array<{ key: string }> };
    expect(editorData.sections.some((entry) => entry.key === 'cta')).toBe(false);

    const preview = await plugin.fetch(
      adminRequest('/__plugin/admin/preview/data?theme=example-theme&template=page&page_id=12&language=en'),
      env(),
    );
    expect((await preview.json() as { structure: { deleted: string[] } }).structure.deleted)
      .toEqual(['cta']);
  });

  it('forgets an unpublished section entirely when it is deleted', async () => {
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      throw new Error(`Unexpected call ${url}`);
    });

    await plugin.fetch(
      adminRequest('/__plugin/admin/section-add', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ theme: 'example-theme', template: 'page', type: 'hero' }),
      }),
      env(),
    );
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/section-delete', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ theme: 'example-theme', template: 'page', section: 'hero-2' }),
      }),
      env(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, key: 'hero-2', added: {}, deleted: [] });
    expect(state.store.has(themeOverridesKey('example-theme'))).toBe(false);
  });

  it('opens a section the page has no block for on Schema, with no Values mode', async () => {
    const fixture = page();
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      if (url.pathname === '/__cms/pages') {
        return { pages: url.searchParams.get('page_type') === 'home' ? [fixture] : [], total: 1 };
      }
      throw new Error(`Unexpected call ${url}`);
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/editor?theme=example-theme&template=page&page_id=12&language=en&section=cta'),
      env(),
    );
    const data = await response.json() as Record<string, unknown>;
    expect(data.selectedSection).toBe('cta');
    expect(data.selectedBlock).toBeNull();
    expect(data.selectedLabel).toBe('Cta');
    expect(data.selectedType).toBe('cta');
    expect(data.missingBlock).toBe(true);
    expect(data.pageSelected).toBe(false);
    // Nothing backs the values panel, so the section opens on its bindings
    // rather than on an empty form the reader has to switch away from.
    expect(data.schemaMode).toBe(true);
    // The bindings live in the template, so they are editable with no block.
    const settings = data.schemaSettings as Array<{ id: string; binding: string }>;
    expect(settings.map((setting) => setting.id)).toContain('title');
    expect(settings.find((setting) => setting.id === 'title')?.binding)
      .toBe('{{ page.blocks[8].title }}');
    expect(data.schemaSection).toBe('cta');

    const html = await renderEditorSection(data);
    expect(html).toContain('name="setting:title" value="{{ page.blocks[8].title }}"');
    // The Values mode is not offered, and the schema panel is the live one.
    expect(html).toMatch(/data-theme-editor-mode="values"[^>]*\shidden/);
    expect(html).toMatch(/data-theme-editor-panel="schema"[^>]*>/);
    expect(html).not.toMatch(/data-theme-editor-panel="schema"[^>]*\sdisabled/);
    expect(html).toMatch(/data-theme-editor-panel="values"[^>]*\sdisabled hidden/);
  });

  it('keeps both modes for a section the page does have a block for', async () => {
    const fixture = page();
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      if (url.pathname === '/__cms/pages') {
        return { pages: url.searchParams.get('page_type') === 'home' ? [fixture] : [], total: 1 };
      }
      throw new Error(`Unexpected call ${url}`);
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/editor?theme=example-theme&template=page&page_id=12&language=en&section=hero'),
      env(),
    );
    const data = await response.json() as Record<string, unknown>;
    expect(data.selectedSection).toBe('hero');
    expect(data.selectedBlock).toBe(0);
    expect(data.missingBlock).toBe(false);
    expect(data.schemaMode).toBe(false);

    const html = await renderEditorSection(data);
    expect(html).not.toMatch(/data-theme-editor-mode="values"[^>]*\shidden/);
    expect(html).toContain('name="field:/_blocks/0/title/en"');
  });

  it('lists sections bound to no block so they stay toggleable', async () => {
    const fixture = page();
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      if (url.pathname === '/__cms/pages') {
        return { pages: url.searchParams.get('page_type') === 'home' ? [fixture] : [], total: 1 };
      }
      throw new Error(`Unexpected call ${url}`);
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/editor?theme=example-theme&template=news-article&page_id=12&language=en'),
      env(),
    );
    const data = await response.json() as Record<string, unknown>;
    const sections = data.sections as Array<{ key: string; hidden: boolean; hasBlock: boolean }>;
    expect(sections.map((entry) => entry.key)).toContain('content');
    expect(sections.every((entry) => entry.hidden === false)).toBe(true);
    expect(sections.every((entry) => entry.hasBlock === false)).toBe(true);
    // A block no section reads keeps a row of its own, so it stays editable.
    const orphans = data.orphanBlocks as Array<{ index: number }>;
    expect(orphans.map((block) => block.index)).toEqual([0]);

    const html = await renderEditorSection(data);
    expect(html).toContain('Template sections');
    expect(html).toContain('Page blocks');
    expect(html).toContain('name="section" value="content"');
  });

  it('serves the page as JSON for the browser renderer', async () => {
    const fixture = page();
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      if (url.pathname === '/__cms/pages/12') return { page: fixture };
      if (url.pathname === '/__cms/pages') return { pages: [], total: 0 };
      throw new Error(`Unexpected call ${url}`);
    });
    state = cmsState({
      [themeOverridesKey('example-theme')]: { page: { hidden: ['cta'], settings: {} } },
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/preview/data?theme=example-theme&template=page&page_id=12&language=en&block=0'),
      env(),
    );
    expect(response.status).toBe(200);
    const data = await response.json() as {
      context: { page: { id: number; lect: unknown }; selectedBlock: number; languages: string[] };
      template: { id: string; path: string };
      hidden: string[];
      runtime: { siteTitle: string };
    };
    expect(data.context.page.id).toBe(12);
    expect(data.context.page.lect).toEqual(fixture.lect);
    expect(data.context.selectedBlock).toBe(0);
    expect(data.context.languages).toEqual(['en', 'zh-hant']);
    expect(data.template).toMatchObject({ id: 'page', path: '/templates/page.json' });
    expect(data.hidden).toEqual(['cta']);
    expect(data.runtime.siteTitle).toBe('Preview site');
  });

  it('serves the theme sources the browser renderer resolves by path', async () => {
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/preview/bundle?theme=example-theme'),
      env(),
    );
    expect(response.status).toBe(200);
    const bundle = await response.json() as Record<string, string>;

    // Whatever the renderer may `{% render %}` has to be present, since the
    // browser store cannot fall back to a fetch for a missing partial.
    expect(bundle['/layout/default.liquid']).toContain('{% block content %}');
    expect(bundle['/sections/hero.liquid']).toContain('hero');
    expect(bundle['/snippets/header.liquid']).toBeTypeOf('string');
    expect(bundle['/templates/page.json']).toContain('"sections"');
    expect(Object.keys(bundle).every((path) => path.startsWith('/'))).toBe(true);
    expect(Object.keys(bundle).some((path) => path.includes('..'))).toBe(false);
  });

  it('hides a template section for every page the template renders', async () => {
    const fixture = page();
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      if (url.pathname === '/__cms/pages/12') return { page: fixture };
      if (url.pathname === '/__cms/pages') return { pages: [], total: 0 };
      throw new Error(`Unexpected call ${url}`);
    });

    expect(await renderPreview(fixture)).toContain('class="hero hero--cream');

    const toggle = await plugin.fetch(
      adminRequest('/__plugin/admin/visibility', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          theme: 'example-theme',
          template: 'page',
          section: 'hero',
          page_id: '12',
          language: 'en',
          hidden: '1',
        }),
      }),
      env(),
    );
    expect(toggle.status).toBe(302);
    expect(toggle.headers.get('location')).toContain('flash=Hidden%20hero');
    // A block in the URL makes the client open the settings panel over the
    // list the toggle was used from, so visibility changes must not carry one.
    expect(toggle.headers.get('location')).not.toContain('block=');
    expect(JSON.parse(state.store.get(themeOverridesKey('example-theme')) as string))
      .toEqual({ page: { hidden: ['hero'], settings: {} } });

    // Stored per template, so the section is gone from the compiled order for
    // any page rendered through it — not just the page that was open. The
    // stored set is what the data route hands the browser renderer.
    const data = await plugin.fetch(
      adminRequest('/__plugin/admin/preview/data?theme=example-theme&template=page&page_id=12&language=en'),
      env(),
    );
    expect((await data.json() as { hidden: string[] }).hidden).toEqual(['hero']);

    const html = await renderPreview(fixture, { hidden: ['hero'] });
    expect(html).not.toContain('class="hero hero--cream');
    expect(html).toContain('Preview site');
  });

  it('renders pending section additions and order before they are published', async () => {
    const html = await renderPreview(page(), {
      structure: {
        order: ['cta', 'hero', 'faq-2'],
        added: { 'faq-2': { type: 'faq' } },
        deleted: [],
      },
    });
    expect(html.indexOf('class="cta')).toBeLessThan(html.indexOf('class="hero'));
    expect((html.match(/class="faq/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('answers a toggle with the new hidden set so nothing has to reload', async () => {
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      throw new Error(`Unexpected call ${url}`);
    });

    const toggle = (section: string, hidden: '0' | '1') => plugin.fetch(
      adminRequest('/__plugin/admin/visibility', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'x-requested-with': 'XMLHttpRequest',
        },
        body: new URLSearchParams({
          theme: 'example-theme',
          template: 'page',
          section,
          hidden,
        }),
      }),
      env(),
    );

    // No redirect: the editor page updates the row and redraws the frame from
    // the returned set.
    const first = await toggle('hero', '1');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, section: 'hero', hidden: ['hero'] });

    const second = await toggle('cta', '1');
    expect(await second.json()).toMatchObject({ ok: true, hidden: ['cta', 'hero'] });

    const shown = await toggle('hero', '0');
    expect(await shown.json()).toMatchObject({ ok: true, section: 'hero', hidden: ['cta'] });
  });

  it('reports a failed toggle so the editor can fall back to a real submit', async () => {
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      throw new Error(`Unexpected call ${url}`);
    });
    // The CMS refuses to store the change, so the toggle did not happen.
    state.handle = (url: URL, method: string) => {
      if (!url.pathname.startsWith('/__cms/state')) return null;
      return method === 'GET'
        ? Response.json({ error: 'not_found' }, { status: 404 })
        : Response.json({ error: 'unavailable' }, { status: 503 });
    };

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/visibility', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          theme: 'example-theme',
          template: 'page',
          section: 'hero',
          hidden: '1',
        }),
      }),
      env(),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it('refuses section keys the selected template does not declare', async () => {
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      throw new Error(`Unexpected call ${url}`);
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/visibility', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          theme: 'example-theme',
          template: 'page',
          section: 'not-a-section',
          hidden: '1',
        }),
      }),
      env(),
    );
    expect(response.status).toBe(404);
    expect(state.store.size).toBe(0);
  });

  it('reports a store that will not take the change instead of dropping it', async () => {
    mockCms(({ url }) => {
      if (url.pathname === '/__cms/content-meta') return contentMeta();
      throw new Error(`Unexpected call ${url}`);
    });
    // The CMS holds the override layer, so a host that refuses the write means
    // the toggle did not land — and must say so rather than looking like it did.
    state.handle = (url: URL, method: string) => {
      if (!url.pathname.startsWith('/__cms/state')) return null;
      return method === 'GET'
        ? Response.json({ error: 'not_found' }, { status: 404 })
        : Response.json({ error: 'unavailable' }, { status: 503 });
    };

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/visibility', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          theme: 'example-theme',
          template: 'page',
          section: 'hero',
          hidden: '1',
        }),
      }),
      env(),
    );
    expect(response.status).toBe(302);
    expect(decodeURIComponent(response.headers.get('location') ?? '')).toContain('could not be reached');
  });

  it('denies section visibility changes without write access', async () => {
    const response = await plugin.fetch(
      adminRequest(
        '/__plugin/admin/visibility',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ theme: 'example-theme', template: 'page', section: 'hero', hidden: '1' }),
        },
        { id: '42', role: 'viewer', permissions: ['theme-editor:view'] },
      ),
      env(),
    );
    expect(response.status).toBe(403);
  });

  it('keeps block overlays when the theme owns the block loop', async () => {
    // `news-article` renders blocks through a `{ "type": "content" }` section,
    // so the plugin never sees the iteration and cannot wrap it from outside.
    const html = await renderPreview(page(), { templateId: 'news-article' });
    expect(html).toContain('class="hero hero--cream');
    expect(html).toContain('theme-editor-block is-selected');
    expect(html).toContain('data-theme-editor-block="0"');
  });

  it('renders a selected JSON template from the synced theme manifest', async () => {
    const article = page({
      id: 14,
      page_type: 'news',
      name: 'Studio update',
      lect: {
        _type: 'news',
        title: { en: 'Studio update' },
        summary: { en: 'A new colour story.' },
      },
    });

    const html = await renderPreview(page(), { templateId: 'news-index', news: [article] });
    expect(html).toContain('Studio update');
    expect(html).toContain('A new colour story.');
    expect(html).toContain('card-grid card-grid--3');
  });

  it('updates lect through the CMS API and attributes the mutation to the editor', async () => {
    const fixture = page();
    const calls = mockCms(({ method, url }) => {
      if (method === 'GET' && url.pathname === '/__cms/pages/12') return { page: fixture };
      if (method === 'PATCH' && url.pathname === '/__cms/pages/12') return { page: fixture };
      throw new Error(`Unexpected call ${method} ${url}`);
    });

    const body = new URLSearchParams({
      theme: 'example-theme',
      template: 'page',
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
    expect(response.headers.get('location')).toContain('theme=example-theme');
    expect(response.headers.get('location')).toContain('template=page');
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

  it('returns the updated lect for an AJAX save without redirecting', async () => {
    const fixture = page();
    mockCms(({ method, url }) => {
      if (method === 'GET' && url.pathname === '/__cms/pages/12') return { page: fixture };
      if (method === 'PATCH' && url.pathname === '/__cms/pages/12') return { page: fixture };
      throw new Error(`Unexpected call ${method} ${url}`);
    });

    const body = new URLSearchParams({
      theme: 'example-theme',
      template: 'news-index',
      page_id: '12',
      language: 'en',
      block: '0',
      'field:/_blocks/0/title/en': 'Saved without reloading',
    });
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/save', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'x-requested-with': 'XMLHttpRequest',
        },
        body,
      }),
      env(),
    );

    expect(response.status).toBe(200);
    const data = await response.json() as {
      ok: boolean;
      message: string;
      templateId: string;
      block: number;
      lect: Record<string, unknown>;
    };
    expect(data.ok).toBe(true);
    expect(data.message).toBe('Changes saved');
    expect(data.templateId).toBe('news-index');
    expect(data.block).toBe(0);
    const block = (data.lect._blocks as Array<Record<string, unknown>>)[0];
    expect((block.title as Record<string, unknown>).en).toBe('Saved without reloading');
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
