import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearTenantCache } from '@lionrockjs/worker-cms-plugin';
import worker from '../src/index';
import { parseRepo, repoFromUrl } from '../src/theme/github';
import type { PluginEnv } from '../src/types';

const SECRET = 'theme-editor-test-secret';
const TOKEN = 'gh-test-token';
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
    ...overrides,
  };
}

function adminRequest(path: string, body: Record<string, string>): Request {
  return new Request(`https://plugin.example.com${path}`, {
    method: 'POST',
    headers: {
      'x-plugin-secret': SECRET,
      'x-cms-user': JSON.stringify({ id: '42', role: 'editor' }),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(body),
  });
}

const PAGE_JSON = JSON.stringify({
  layout: 'default',
  sections: { hero: { type: 'hero', settings: {} } },
  order: ['hero'],
}, null, 2);

/**
 * Stands in for api.github.com. Nothing in these tests reaches the real
 * service: a push is an outward-facing, hard-to-undo action, so it is exercised
 * against a recorded contract instead.
 */
function gitHub(files: Record<string, string> = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const blobs = new Map<string, string>();
  let committed: { tree: unknown; parents: string[]; message: string } | null = null;
  let ref = 'head-sha';

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });

    if (url.hostname !== 'api.github.com') throw new Error(`Unexpected host ${url.hostname}`);
    if (init.headers && (init.headers as Record<string, string>).authorization !== `Bearer ${TOKEN}`) {
      return new Response('bad credentials', { status: 401 });
    }

    if (url.pathname.includes('/git/ref/heads/')) {
      return Response.json({ object: { sha: ref } });
    }
    if (url.pathname.includes('/git/commits/')) {
      return Response.json({ tree: { sha: 'tree-sha' } });
    }
    if (url.pathname.endsWith('/git/trees/tree-sha')) {
      return Response.json({
        truncated: false,
        tree: Object.keys(files).map((path) => ({ path, type: 'blob', sha: `blob-${path}` })),
      });
    }
    if (url.pathname.includes('/git/blobs/')) {
      const path = url.pathname.split('/git/blobs/blob-')[1];
      return Response.json({
        encoding: 'base64',
        content: Buffer.from(files[decodeURIComponent(path)] ?? '', 'utf8').toString('base64'),
      });
    }
    if (method === 'POST' && url.pathname.endsWith('/git/blobs')) {
      const sha = `new-blob-${blobs.size}`;
      blobs.set(sha, body.content);
      return Response.json({ sha });
    }
    if (method === 'POST' && url.pathname.endsWith('/git/trees')) {
      return Response.json({ sha: 'new-tree' });
    }
    if (method === 'POST' && url.pathname.endsWith('/git/commits')) {
      committed = body;
      return Response.json({ sha: 'commit-abcdef1234' });
    }
    if (method === 'PATCH' && url.pathname.includes('/git/refs/heads/')) {
      ref = body.sha;
      return Response.json({ object: { sha: body.sha } });
    }
    return new Response('not found', { status: 404 });
  });

  return {
    calls,
    blobs,
    get committed() { return committed; },
    get ref() { return ref; },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearTenantCache();
});

describe('GitHub theme source', () => {
  it('reads repo coordinates from a pasted URL', () => {
    expect(repoFromUrl('https://github.com/Example-Org/website.git'))
      .toEqual({ owner: 'Example-Org', repo: 'website' });
    expect(repoFromUrl('https://github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
    expect(repoFromUrl('not a url')).toBeNull();
    expect(parseRepo({ owner: 'o', repo: 'r' })?.branch).toBe('main');
    expect(parseRepo({ owner: '', repo: 'r' })).toBeNull();
  });

  it('clones a repository directory into the bucket as a theme', async () => {
    const THEMES = bucket();
    const api = gitHub({
      'views/templates/page.json': PAGE_JSON,
      'views/sections/hero.liquid': '<section class="hero"></section>',
      'views/theme-manifest.json': JSON.stringify({ name: 'Website' }),
      // Outside the theme directory, and not a theme file: neither is cloned.
      'README.md': '# repo',
      'views/notes.txt': 'ignored',
    });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/github', {
        url: 'https://github.com/Example-Org/website.git',
        branch: 'main',
        path: 'views',
        theme_id: 'website',
      }),
      env({ THEMES, GITHUB_TOKEN: TOKEN }),
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { ok: boolean; message: string };
    expect(payload.ok).toBe(true);
    expect(payload.message).toContain('Example-Org/website@main');

    // Files land under the theme's folder, with the repo directory stripped.
    expect(THEMES.store.get('website/templates/page.json')).toBe(PAGE_JSON);
    expect(THEMES.store.get('website/sections/hero.liquid')).toBe('<section class="hero"></section>');
    expect(THEMES.store.has('website/notes.txt')).toBe(false);
    expect([...THEMES.store.keys()].some((key) => key.includes('README'))).toBe(false);

    // The manifest records where it came from, so pushing needs no second setup.
    const manifest = JSON.parse(THEMES.store.get('website/theme-manifest.json') as string);
    expect(manifest).toMatchObject({
      name: 'Website',
      repo: { owner: 'Example-Org', repo: 'website', branch: 'main', path: 'views' },
    });
    expect(api.calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  it('commits the theme templates back to the branch it came from', async () => {
    const THEMES = bucket({
      'website/theme-manifest.json': JSON.stringify({
        repo: { owner: 'Example-Org', repo: 'website', branch: 'main', path: 'views' },
        templates: [{ id: 'page', label: 'Page', path: '/templates/page.json', format: 'json' }],
        files: ['/templates/page.json'],
      }),
      'website/templates/page.json': PAGE_JSON,
    });
    const api = gitHub({ 'views/templates/page.json': PAGE_JSON });

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/github/push', {
        theme: 'website',
        message: 'Update templates',
      }),
      env({ THEMES, GITHUB_TOKEN: TOKEN }),
    );
    expect(response.status).toBe(200);
    expect((await response.json() as { message: string }).message).toContain('commit');

    // Blob → tree → commit → ref, the Git Data API sequence a push needs.
    const sequence = api.calls.filter((call) => call.method !== 'GET').map((call) =>
      `${call.method} ${call.path.split('/git/')[1]}`);
    expect(sequence).toEqual(['POST blobs', 'POST trees', 'POST commits', 'PATCH refs/heads/main']);

    // Built on the branch's current tree, so files the editor never touched are
    // carried over rather than dropped by omission.
    const tree = api.calls.find((call) => call.path.endsWith('/git/trees'))?.body as {
      base_tree: string;
      tree: Array<{ path: string }>;
    };
    expect(tree.base_tree).toBe('tree-sha');
    expect(tree.tree.map((entry) => entry.path)).toEqual(['views/templates/page.json']);
    expect(api.committed).toMatchObject({ message: 'Update templates', parents: ['head-sha'] });
    expect(api.ref).toBe('commit-abcdef1234');
  });

  it('tells an invisible private repo apart from a missing branch', async () => {
    // GitHub answers 404 for a private repository a token cannot see, exactly
    // as it does for a branch that is not there.
    const repoVisible = { value: false };
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.includes('/git/ref/heads/')) return new Response('{}', { status: 404 });
      if (url.pathname === '/user') return Response.json({ login: 'colin' });
      if (url.pathname === '/repos/o/r') {
        return repoVisible.value
          ? Response.json({ default_branch: 'trunk' })
          : new Response('{}', { status: 404 });
      }
      if (url.pathname === '/repos/o/r/branches') {
        return Response.json([{ name: 'trunk' }, { name: 'develop' }]);
      }
      return new Response('{}', { status: 404 });
    });

    const clone = () => plugin.fetch(
      adminRequest('/__plugin/admin/github', { owner: 'o', repo: 'r', branch: 'main', path: 'views' }),
      env({ THEMES: bucket(), GITHUB_TOKEN: TOKEN }),
    );

    const noAccess = await (await clone()).json() as { message: string };
    expect(noAccess.message).toContain('cannot see o/r');
    expect(noAccess.message).toContain('resource owner');
    expect(noAccess.message).toContain('authenticates as colin');

    // The same status, with the repository visible, is a branch problem — and
    // says which branches there are instead of leaving it to guesswork.
    repoVisible.value = true;
    const wrongBranch = await (await clone()).json() as { message: string };
    expect(wrongBranch.message).toContain('no branch `main`');
    expect(wrongBranch.message).toContain('default branch is `trunk`');
    expect(wrongBranch.message).toContain('trunk, develop');
  });

  it('will not push a theme that was never cloned from GitHub', async () => {
    const THEMES = bucket({
      'plain/theme-manifest.json': JSON.stringify({ templates: [], files: [] }),
    });
    const api = gitHub();

    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/github/push', { theme: 'plain' }),
      env({ THEMES, GITHUB_TOKEN: TOKEN }),
    );
    expect(response.status).toBe(400);
    expect((await response.json() as { message: string }).message).toContain('nowhere to push');
    expect(api.calls).toEqual([]);
  });

  it('says what is missing rather than half-doing the work', async () => {
    const noToken = await plugin.fetch(
      adminRequest('/__plugin/admin/github', { url: 'https://github.com/o/r' }),
      env({ THEMES: bucket() }),
    );
    expect(noToken.status).toBe(503);
    expect((await noToken.json() as { message: string }).message).toContain('GITHUB_TOKEN');

    const noBucket = await plugin.fetch(
      adminRequest('/__plugin/admin/github', { url: 'https://github.com/o/r' }),
      env({ GITHUB_TOKEN: TOKEN }),
    );
    expect(noBucket.status).toBe(503);
    expect((await noBucket.json() as { message: string }).message).toContain('bucket');
  });

  it('takes the token from the tenant registry, so each CMS pushes as itself', async () => {
    const TENANT_TOKEN = 'tenant-scoped-token';
    const TENANT_SECRET = 'tenant-pairwise-secret';
    // One plugin Worker serving several CMS hosts: the token belongs to the
    // tenant, not the Worker, so each pushes to its own repository as itself.
    const record = {
      cmsUrl: 'https://cms1.example.com',
      secret: TENANT_SECRET,
      vars: { GITHUB_TOKEN: TENANT_TOKEN },
    };
    const TENANTS = {
      get: async (key: string, type?: string) => {
        if (key !== 'tenant:https://cms1.example.com') return null;
        return type === 'json' ? record : JSON.stringify(record);
      },
      list: async () => ({ keys: [{ name: 'tenant:https://cms1.example.com' }], list_complete: true }),
    } as unknown as KVNamespace;

    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname !== 'api.github.com') throw new Error(`Unexpected host ${url.hostname}`);
      seen.push(String((init.headers as Record<string, string>).authorization));
      return Response.json({ object: { sha: 'head' } });
    });

    const request = new Request('https://plugin.example.com/__plugin/admin/github', {
      method: 'POST',
      headers: {
        'x-cms-tenant': 'https://cms1.example.com',
        'x-plugin-secret': TENANT_SECRET,
        'x-cms-user': JSON.stringify({ id: '42', role: 'editor' }),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({ url: 'https://github.com/o/r', path: 'views' }),
    });

    // No GITHUB_TOKEN on the Worker at all: the tenant supplies it.
    await plugin.fetch(request, {
      VIEWS: views(),
      TENANTS,
      THEMES: bucket(),
    } as unknown as PluginEnv);

    expect(seen[0]).toBe(`Bearer ${TENANT_TOKEN}`);
  });

  it('denies GitHub actions without write access', async () => {
    const request = new Request('https://plugin.example.com/__plugin/admin/github/push', {
      method: 'POST',
      headers: {
        'x-plugin-secret': SECRET,
        'x-cms-user': JSON.stringify({ id: '42', role: 'viewer', permissions: ['theme-editor:view'] }),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ theme: 'website' }),
    });
    const response = await plugin.fetch(request, env({ THEMES: bucket(), GITHUB_TOKEN: TOKEN }));
    expect(response.status).toBe(403);
  });
});
