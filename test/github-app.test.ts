import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  clearPluginStateCache,
  clearTenantCache,
  tenantRef,
} from '@lionrockjs/worker-cms-plugin';
import worker from '../src/index';
import type { PluginEnv } from '../src/types';
import { hostLiquid } from './host-liquid';

const SECRET = 'theme-editor-test-secret';
const STATE_SECRET = 'state-secret-with-at-least-32-bytes';
const APP_ID = '12345';
const INSTALLATION_ID = 98765;
const INSTALLATION_TOKEN = 'ghs_installation_token';
const USER_TOKEN = 'ghu_temporary_user_token';
const plugin = worker as { fetch(request: Request, env: PluginEnv): Promise<Response> };

let privateKeyPem = '';

beforeAll(() => {
  privateKeyPem = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
});

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

function kv(seed: Record<string, string> = {}): KVNamespace & { store: Map<string, string> } {
  const store = new Map(Object.entries(seed));
  return {
    store,
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

function bucket(seed: Record<string, string> = {}): R2Bucket & { store: Map<string, string> } {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (key: string) => store.has(key) ? { text: async () => store.get(key) as string } : null,
    head: async (key: string) => store.has(key) ? {} : null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    list: async ({ prefix = '', delimiter }: { prefix?: string; delimiter?: string } = {}) => {
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix));
      if (!delimiter) return { objects: keys.map((key) => ({ key })), delimitedPrefixes: [], truncated: false };
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

function env(overrides: Partial<PluginEnv> = {}): PluginEnv {
  return {
    VIEWS: views(),
    CMS_URL: 'https://cms.example.com',
    PLUGIN_SECRET: SECRET,
    THEMES: bucket(),
    GITHUB_CONNECTIONS: kv(),
    GITHUB_APP_ID: APP_ID,
    GITHUB_APP_SLUG: 'zeroxcms-theme-editor',
    GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    GITHUB_APP_CLIENT_ID: 'Iv1.client',
    GITHUB_APP_CLIENT_SECRET: 'client-secret',
    GITHUB_APP_STATE_SECRET: STATE_SECRET,
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

function githubConnection(): string {
  return JSON.stringify({
    installationId: INSTALLATION_ID,
    accountLogin: 'Acme',
    accountType: 'Organization',
    repositorySelection: 'selected',
    manageUrl: `https://github.com/organizations/Acme/settings/installations/${INSTALLATION_ID}`,
    connectedAt: '2026-07-31T00:00:00.000Z',
  });
}

/**
 * Stands in for the CMS's `/__cms/state` store — the connected installation now
 * belongs to the host, not to this Worker, so these tests assert against what
 * the host was asked to keep rather than a KV namespace here.
 */
function cmsState(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    /** Answers a state request the way the host does, or null if not one. */
    handle(url: URL, method: string, body: unknown): Response | null {
      if (!url.pathname.startsWith('/__cms/state/')) return null;
      const key = decodeURIComponent(url.pathname.slice('/__cms/state/'.length));
      if (method === 'PUT') {
        store.set(key, JSON.stringify((body as { value: unknown }).value));
        return Response.json({ ok: true, key });
      }
      if (method === 'DELETE') {
        store.delete(key);
        return Response.json({ ok: true, key });
      }
      const value = store.get(key);
      return value === undefined
        ? Response.json({ error: 'not_found' }, { status: 404 })
        : Response.json({ key, value });
    },
  };
}

const CONNECTION_KEY = 'github.connection';

function mockInstallationApi(options: {
  includeUserInstallation?: boolean;
  includeRepositories?: boolean;
  /** The host's state store; defaults to an empty one (nothing connected). */
  state?: ReturnType<typeof cmsState>;
} = {}): Array<{ url: URL; method: string; authorization: string; body: unknown }> {
  const calls: Array<{ url: URL; method: string; authorization: string; body: unknown }> = [];
  const state = options.state ?? cmsState();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;

    // Kept out of `calls`, which exists to pin what was sent to GitHub.
    const hosted = state.handle(url, method, body);
    if (hosted) return hosted;

    calls.push({ url, method, authorization: headers.get('authorization') ?? '', body });

    if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') {
      return Response.json({ access_token: USER_TOKEN, token_type: 'bearer', scope: '' });
    }
    if (url.pathname === '/user/installations') {
      return Response.json({
        total_count: options.includeUserInstallation === false ? 0 : 1,
        installations: options.includeUserInstallation === false ? [] : [{
          id: INSTALLATION_ID,
          app_id: Number(APP_ID),
          account: { login: 'Acme', type: 'Organization' },
          permissions: { contents: 'write', metadata: 'read' },
          repository_selection: 'selected',
          html_url: `https://github.com/organizations/Acme/settings/installations/${INSTALLATION_ID}`,
        }],
      });
    }
    if (url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      expect(method).toBe('POST');
      expect(headers.get('authorization')).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({
        token: INSTALLATION_TOKEN,
        expires_at: '2026-07-31T02:00:00Z',
      });
    }
    if (url.pathname === '/installation/repositories') {
      expect(headers.get('authorization')).toBe(`Bearer ${INSTALLATION_TOKEN}`);
      const repositories = options.includeRepositories === false ? [] : [{
        id: 77,
        full_name: 'Acme/storefront-theme',
        name: 'storefront-theme',
        owner: { login: 'Acme' },
        default_branch: 'trunk',
        private: true,
      }];
      return Response.json({ total_count: repositories.length, repositories });
    }
    throw new Error(`Unexpected GitHub request ${method} ${url}`);
  });
  return calls;
}

async function renderThemes(data: Record<string, unknown>): Promise<string> {
  const source = await readFile(
    fileURLToPath(new URL('../views/sections/themes.liquid', import.meta.url)),
    'utf8',
  );
  return String(await new (hostLiquid().Liquid)({ outputEscape: 'escape' }).parseAndRender(source, data));
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearTenantCache();
  // State reads are cached per isolate; without this a connection stored by
  // one test would still be visible to the next.
  clearPluginStateCache();
});

describe('GitHub App connection', () => {
  it('starts a signed tenant-aware installation flow from the dashboard', async () => {
    const pluginEnv = env();
    mockInstallationApi();
    const dashboard = await plugin.fetch(adminRequest('/__plugin/admin'), pluginEnv);
    const data = await dashboard.json() as Record<string, unknown>;
    expect(data.githubAppConfigured).toBe(true);
    expect(data.githubConnected).toBe(false);
    expect(data.githubConnectAction).toBe('/admin/plugins/theme-editor/github/connect');

    const html = await renderThemes(data);
    expect(html).toContain('Connect GitHub');
    expect(html).toContain('href="/admin/plugins/theme-editor/github/connect"');
    expect(html).not.toContain('action="/admin/plugins/theme-editor/github/connect"');

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/github/connect'),
      pluginEnv,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') as string);
    expect(location.origin).toBe('https://github.com');
    expect(location.pathname).toBe('/apps/zeroxcms-theme-editor/installations/new');
    expect(location.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('verifies the installer and stores only installation metadata', async () => {
    const hosted = cmsState();
    const pluginEnv = env();
    const started = await plugin.fetch(adminRequest('/__plugin/admin/github/connect', {
      method: 'POST',
    }), pluginEnv);
    const state = new URL(started.headers.get('location') as string).searchParams.get('state');
    const calls = mockInstallationApi({ state: hosted });

    const callback = await plugin.fetch(new Request(
      `https://plugin.example.com/__plugin/github/callback`
      + `?code=temporary-code&installation_id=${INSTALLATION_ID}&setup_action=install`
      + `&state=${encodeURIComponent(state as string)}`,
    ), pluginEnv);

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toContain(
      'https://cms.example.com/admin/plugins/theme-editor?flash=Connected',
    );
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      'POST /login/oauth/access_token',
      'GET /user/installations',
    ]);
    // The record went to the CMS that owns it, not into this Worker's storage.
    expect(hosted.store.size).toBe(1);
    const stored = hosted.store.get(CONNECTION_KEY) as string;
    expect(JSON.parse(stored)).toMatchObject({
      installationId: INSTALLATION_ID,
      accountLogin: 'Acme',
      repositorySelection: 'selected',
    });
    expect(stored).not.toContain(USER_TOKEN);
    expect(stored).not.toContain('client-secret');
  });

  it('rejects a tampered state and an installation the GitHub user cannot access', async () => {
    const hosted = cmsState();
    const pluginEnv = env();
    const started = await plugin.fetch(adminRequest('/__plugin/admin/github/connect', {
      method: 'POST',
    }), pluginEnv);
    const state = new URL(started.headers.get('location') as string).searchParams.get('state') as string;
    const tampered = `${state.slice(0, -1)}${state.endsWith('a') ? 'b' : 'a'}`;

    const invalid = await plugin.fetch(new Request(
      `https://plugin.example.com/__plugin/github/callback?code=x`
      + `&installation_id=${INSTALLATION_ID}&state=${encodeURIComponent(tampered)}`,
    ), pluginEnv);
    expect(invalid.status).toBe(400);

    mockInstallationApi({ includeUserInstallation: false, state: hosted });
    const inaccessible = await plugin.fetch(new Request(
      `https://plugin.example.com/__plugin/github/callback?code=x`
      + `&installation_id=${INSTALLATION_ID}&state=${encodeURIComponent(state)}`,
    ), pluginEnv);
    expect(inaccessible.status).toBe(302);
    expect(decodeURIComponent(inaccessible.headers.get('location') as string))
      .toContain('cannot access that App installation');
    expect(hosted.store.size).toBe(0);
  });

  it('lists granted repositories and renders the add-theme form', async () => {
    const pluginEnv = env();
    mockInstallationApi({ state: cmsState({ [CONNECTION_KEY]: githubConnection() }) });

    const dashboard = await plugin.fetch(adminRequest('/__plugin/admin'), pluginEnv);
    const data = await dashboard.json() as Record<string, unknown>;
    expect(data.githubConnected).toBe(true);
    expect(data.githubAccount).toBe('Acme');
    expect(data.githubRepositories).toEqual([
      expect.objectContaining({
        fullName: 'Acme/storefront-theme',
        defaultBranch: 'trunk',
        private: true,
      }),
    ]);

    const html = await renderThemes(data);
    expect(html).toContain('Connected to Acme');
    expect(html).toContain('Manage repositories');
    expect(html).toContain('value="Acme/storefront-theme"');
    expect(html).toContain('blank for root');
    expect(html).toContain('Add theme');
  });

  it('does not expose private repository metadata to a view-only CMS user', async () => {
    // Not even the connection lookup should happen: a view-only user gets no
    // GitHub detail, so nothing is asked of GitHub or of the host.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('A view-only dashboard must not call GitHub');
    }));

    const dashboard = await plugin.fetch(
      adminRequest(
        '/__plugin/admin',
        {},
        { id: '8', role: 'viewer', permissions: ['theme-editor:view'] },
      ),
      env(),
    );
    expect(dashboard.status).toBe(200);
    const data = await dashboard.json() as Record<string, unknown>;
    expect(data.githubConnected).toBe(false);
    expect(data.githubRepositories).toEqual([]);
    expect(data.githubAccount).toBe('');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('uses a short-lived installation token to clone the selected repository', async () => {
    const hosted = cmsState({ [CONNECTION_KEY]: githubConnection() });
    const themes = bucket();
    const pluginEnv = env({
      THEMES: themes,
      // A connected App must win rather than silently widening access through
      // a deployment-wide personal token.
      GITHUB_TOKEN: 'pat-must-not-be-used',
    });
    const template = JSON.stringify({ layout: 'default', sections: {}, order: [] });

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init.headers);
      const hostedResponse = hosted.handle(url, init.method ?? 'GET', undefined);
      if (hostedResponse) return hostedResponse;
      if (url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
        expect(headers.get('authorization')).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
        return Response.json({ token: INSTALLATION_TOKEN });
      }
      expect(headers.get('authorization')).toBe(`Bearer ${INSTALLATION_TOKEN}`);
      if (url.pathname === '/repos/Acme/storefront-theme') {
        return Response.json({ default_branch: 'trunk' });
      }
      if (url.pathname.endsWith('/git/ref/heads/trunk')) {
        return Response.json({ object: { sha: 'head' } });
      }
      if (url.pathname.endsWith('/git/commits/head')) {
        return Response.json({ tree: { sha: 'tree' } });
      }
      if (url.pathname.endsWith('/git/trees/tree')) {
        return Response.json({
          truncated: false,
          tree: [{ path: 'templates/page.json', type: 'blob', sha: 'template-blob' }],
        });
      }
      if (url.pathname.endsWith('/git/blobs/template-blob')) {
        return Response.json({
          encoding: 'base64',
          content: Buffer.from(template).toString('base64'),
        });
      }
      throw new Error(`Unexpected GitHub request ${init.method ?? 'GET'} ${url}`);
    });

    const response = await plugin.fetch(adminRequest('/__plugin/admin/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        repository: 'Acme/storefront-theme',
        branch: '',
        path: '',
        theme_id: 'storefront',
      }),
    }), pluginEnv);

    expect(response.status).toBe(200);
    expect(themes.store.get('storefront/templates/page.json')).toBe(template);
    const manifest = JSON.parse(themes.store.get('storefront/theme-manifest.json') as string);
    expect(manifest.repo).toEqual({
      owner: 'Acme',
      repo: 'storefront-theme',
      branch: 'trunk',
      path: '',
    });
  });

  it('disconnects only this CMS connection', async () => {
    // Each host holds its own record, so a disconnect can only ever reach the
    // CMS that asked for it. The pre-migration KV is keyed by tenant ref, and
    // only this tenant's entry may be removed from it.
    const ref = await tenantRef('https://cms.example.com');
    const other = await tenantRef('https://other.example.com');
    const legacy = kv({
      [`github:${ref}`]: githubConnection(),
      [`github:${other}`]: githubConnection(),
    });
    const hosted = cmsState({ [CONNECTION_KEY]: githubConnection() });
    mockInstallationApi({ state: hosted });

    const response = await plugin.fetch(adminRequest('/__plugin/admin/github/disconnect', {
      method: 'POST',
      headers: { accept: 'application/json' },
    }), env({ GITHUB_CONNECTIONS: legacy }));

    expect(response.status).toBe(200);
    expect(hosted.store.has(CONNECTION_KEY)).toBe(false);
    expect(legacy.store.has(`github:${ref}`)).toBe(false);
    expect(legacy.store.has(`github:${other}`)).toBe(true);
  });

  it('adopts a pre-migration KV connection and hands it to the host', async () => {
    // Installs made before the record moved host-side keep working, and the
    // first read migrates them, so the old namespace drains on its own.
    const ref = await tenantRef('https://cms.example.com');
    const legacy = kv({ [`github:${ref}`]: githubConnection() });
    const hosted = cmsState();
    mockInstallationApi({ state: hosted });

    const dashboard = await plugin.fetch(
      adminRequest('/__plugin/admin'),
      env({ GITHUB_CONNECTIONS: legacy }),
    );
    const data = await dashboard.json() as Record<string, unknown>;
    expect(data.githubConnected).toBe(true);
    expect(data.githubAccount).toBe('Acme');
    expect(JSON.parse(hosted.store.get(CONNECTION_KEY) as string)).toMatchObject({
      installationId: INSTALLATION_ID,
      accountLogin: 'Acme',
    });
  });

  it('keeps using a connection the host cannot yet be told about', async () => {
    // A CMS that rejects the write must not read as "never connected": the
    // installation still exists, so the editor keeps working and retries later.
    const ref = await tenantRef('https://cms.example.com');
    const legacy = kv({ [`github:${ref}`]: githubConnection() });
    const unwritable = cmsState();
    unwritable.handle = (url: URL, method: string) => {
      if (!url.pathname.startsWith('/__cms/state/')) return null;
      return method === 'PUT'
        ? Response.json({ error: 'unavailable' }, { status: 503 })
        : Response.json({ error: 'not_found' }, { status: 404 });
    };
    mockInstallationApi({ state: unwritable });

    const dashboard = await plugin.fetch(
      adminRequest('/__plugin/admin'),
      env({ GITHUB_CONNECTIONS: legacy }),
    );
    expect((await dashboard.json() as Record<string, unknown>).githubConnected).toBe(true);
  });
});
