import {
  CmsApiError,
  CmsClient,
  CmsNotConfiguredError,
  type CmsPage,
} from '@lionrockjs/worker-cms-plugin';
import { PLUGIN_ID } from './constants';
import type { ContentMeta, PluginEnv } from './types';

export function cmsClient(env: PluginEnv): CmsClient {
  return new CmsClient(env, PLUGIN_ID);
}

export async function contentMeta(env: PluginEnv): Promise<ContentMeta> {
  const body = await cmsJson<Partial<ContentMeta>>(env, 'GET', '/content-meta');
  const pageTypes = strings(body.page_types);
  const languages = strings(body.languages);
  const defaultLanguage = typeof body.default_language === 'string' && body.default_language
    ? body.default_language
    : languages[0] ?? 'mis';
  return {
    page_types: pageTypes,
    languages: languages.length ? languages : [defaultLanguage],
    default_language: defaultLanguage,
  };
}

export async function listReadablePages(
  env: PluginEnv,
  meta: ContentMeta,
): Promise<CmsPage[]> {
  const cms = cmsClient(env);
  const results = await Promise.all(meta.page_types.map(async (pageType) => {
    const { pages } = await cms.list(pageType, { limit: 500 });
    return pages;
  }));
  return results.flat().sort((left, right) =>
    left.page_type?.localeCompare(right.page_type ?? '')
      || left.name.localeCompare(right.name)
      || left.id - right.id);
}

export async function updatePageLect(
  env: PluginEnv,
  pageId: number,
  lect: Record<string, unknown>,
  userId = '',
): Promise<CmsPage> {
  const path = `/pages/${pageId}`;
  const body = await cmsJson<{ page: CmsPage }>(
    env,
    'PATCH',
    path,
    { lect, version_action: 'theme-editor' },
    userId,
  );
  return body.page;
}

async function cmsJson<T>(
  env: PluginEnv,
  method: string,
  path: string,
  body?: unknown,
  userId = '',
): Promise<T> {
  if (!env.CMS_URL || !env.PLUGIN_SECRET) throw new CmsNotConfiguredError();
  const response = await fetch(`${env.CMS_URL.replace(/\/+$/, '')}/__cms${path}`, {
    method,
    headers: {
      'x-plugin-id': PLUGIN_ID,
      'x-plugin-secret': env.PLUGIN_SECRET,
      ...(userId ? { 'x-acting-user-id': userId } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json<{ error?: string }>()
      .then((value) => value.error || 'error')
      .catch(() => 'error');
    throw new CmsApiError(response.status, error, method, path);
  }
  return response.json<T>();
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim()))];
}
