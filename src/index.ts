import {
  handleTenantEnroll,
  handleTenantRevoke,
  requireTenant,
  serveViewAsset,
  tenantClientEnv,
} from '@lionrockjs/worker-cms-plugin';
import { editorError, handleThemeEditorAdmin } from './editor';
import MANIFEST from './manifest.json';
import { themeEditorAccessForRequest } from './permissions';
import {
  GITHUB_CALLBACK_PATH,
  handleGitHubAppCallback,
} from './theme/github-app';
import { contentTypeFor, type BinaryThemeStore } from './theme/store';
import { isThemeFilePath } from './theme/files';
import { tenantAuthEnv } from './tenant-auth';
import { themeFromId, themeStore } from './themes';
import type { PluginEnv } from './types';

const PLUGIN_VIEW_PREFIXES = ['/templates/', '/sections/', '/snippets/', '/locales/'];

/**
 * No browser reaches these directly: the CMS refetches the bytes on every page
 * that references them, rehashes them against the admin-approved integrity, and
 * serves the copy under its own deploy-stamped URL. The SDK default of a day's
 * public caching therefore buys nothing here and costs correctness — an edge
 * that held the pre-deploy bytes would either hand the editor a stale renderer
 * or fail the integrity check outright.
 */
const PLUGIN_ASSET_CACHING = { assetsCacheControl: 'no-store' } as const;

export default {
  async fetch(request: Request, baseEnv: PluginEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/__plugin/tenants/enroll') {
      return handleTenantEnroll(request, baseEnv, { pluginId: MANIFEST.id });
    }
    if (path === '/__plugin/tenants/revoke') {
      return handleTenantRevoke(request, baseEnv, { pluginId: MANIFEST.id });
    }
    if (path === GITHUB_CALLBACK_PATH) {
      return handleGitHubAppCallback(request, baseEnv);
    }

    if (path === '/__plugin/manifest') {
      return Response.json({
        ...MANIFEST,
        ...(baseEnv.CF_VERSION_METADATA ? { workerVersion: baseEnv.CF_VERSION_METADATA } : {}),
      });
    }

    if (path.startsWith('/assets/')) {
      return serveViewAsset(baseEnv.VIEWS, path, PLUGIN_ASSET_CACHING);
    }

    if (path.startsWith('/__plugin/views/')) {
      const assetPath = path.slice('/__plugin/views'.length);
      return pluginViewAsset(baseEnv.VIEWS, assetPath);
    }

    if (!path.startsWith('/__plugin/admin')) {
      return new Response('not found', { status: 404 });
    }

    const tenant = await requireTenant(request, tenantAuthEnv(baseEnv));
    if (tenant instanceof Response) return tenant;
    const env = tenantClientEnv(baseEnv, tenant);

    if (path.startsWith('/__plugin/admin/views/')) {
      const assetPath = path.slice('/__plugin/admin/views'.length);
      return pluginViewAsset(env.VIEWS, assetPath);
    }
    if (path.startsWith('/__plugin/admin/assets/')) {
      const assetPath = path.slice('/__plugin/admin'.length);
      return serveViewAsset(env.VIEWS, assetPath, PLUGIN_ASSET_CACHING);
    }
    if (path.startsWith('/__plugin/admin/theme/assets/')) {
      return serveThemeAsset(env, url);
    }

    try {
      return await handleThemeEditorAdmin(
        request,
        env,
        url,
        themeEditorAccessForRequest(request),
      );
    } catch (error) {
      console.error('Theme editor request failed', error);
      return editorError(env, error);
    }
  },
};

function pluginViewAsset(views: Fetcher, path: string): Promise<Response> | Response {
  if (!PLUGIN_VIEW_PREFIXES.some((prefix) => path.startsWith(prefix)) || path.includes('..')) {
    return new Response('not found', { status: 404 });
  }
  return serveViewAsset(views, path, { bareLiquidSnippets: true });
}

/**
 * Theme assets belong to the selected theme, which may live in R2 rather than
 * the immutable plugin view bundle. The theme query keeps this route scoped to
 * the same store as the preview data and Liquid bundle.
 */
async function serveThemeAsset(env: PluginEnv, url: URL): Promise<Response> {
  const filename = url.pathname.slice('/__plugin/admin/theme/assets/'.length);
  if (!filename || filename.includes('..') || !/^[a-z0-9][a-z0-9._/-]*$/i.test(filename)) {
    return new Response('not found', { status: 404 });
  }

  const theme = await themeFromId(env, url.searchParams.get('theme'));
  if (!theme) return new Response('Theme not found.', { status: 404 });

  const assetPath = `/assets/${filename}`;
  if (!isThemeFilePath(assetPath)) return new Response('not found', { status: 404 });
  try {
    const store = themeStore(env, theme);
    const bytes = (store as Partial<BinaryThemeStore>).readBytes;
    const body = typeof bytes === 'function'
      ? await bytes.call(store, assetPath)
      : await store.read(assetPath);
    return new Response(body, {
      headers: {
        'content-type': contentTypeFor(assetPath),
        'cache-control': 'no-store',
      },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}
