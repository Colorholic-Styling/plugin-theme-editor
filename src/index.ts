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
import type { PluginEnv } from './types';

const PLUGIN_VIEW_PREFIXES = ['/templates/', '/sections/', '/snippets/', '/locales/'];

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

    if (path === '/__plugin/manifest') {
      return Response.json({
        ...MANIFEST,
        ...(baseEnv.CF_VERSION_METADATA ? { workerVersion: baseEnv.CF_VERSION_METADATA } : {}),
      });
    }

    if (path.startsWith('/assets/')) {
      return serveViewAsset(baseEnv.VIEWS, path);
    }

    if (path.startsWith('/__plugin/views/')) {
      const assetPath = path.slice('/__plugin/views'.length);
      return pluginViewAsset(baseEnv.VIEWS, assetPath);
    }

    if (!path.startsWith('/__plugin/admin')) {
      return new Response('not found', { status: 404 });
    }

    const tenant = await requireTenant(request, baseEnv);
    if (tenant instanceof Response) return tenant;
    const env = tenantClientEnv(baseEnv, tenant);

    if (path.startsWith('/__plugin/admin/views/')) {
      const assetPath = path.slice('/__plugin/admin/views'.length);
      return pluginViewAsset(env.VIEWS, assetPath);
    }
    if (path.startsWith('/__plugin/admin/assets/')) {
      const assetPath = path.slice('/__plugin/admin'.length);
      return serveViewAsset(env.VIEWS, assetPath);
    }
    if (path.startsWith('/__plugin/admin/theme/assets/')) {
      const assetPath = `/theme/assets/${path.slice('/__plugin/admin/theme/assets/'.length)}`;
      return serveViewAsset(env.VIEWS, assetPath);
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
