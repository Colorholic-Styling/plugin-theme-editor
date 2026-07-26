import {
  adminView,
  CmsApiError,
  CmsNotConfiguredError,
  redirect,
  type CmsPage,
} from '@lionrockjs/worker-cms-plugin';
import { ADMIN_BASE, PLUGIN_ID } from './constants';
import { actingUserId, forbidden, type ThemeEditorAccess } from './permissions';
import { cmsClient, contentMeta, listReadablePages, updatePageLect } from './cms';
import {
  applyEditorFields,
  blockChoices,
  editorFields,
  selectedBlockFrom,
} from './editor-model';
import { renderThemePreview } from './theme/colorholic';
import type { PluginEnv } from './types';

export { ADMIN_BASE, PLUGIN_ID };

export async function handleThemeEditorAdmin(
  request: Request,
  env: PluginEnv,
  url: URL,
  access: ThemeEditorAccess,
): Promise<Response> {
  const rest = url.pathname.replace(/^\/__plugin\/admin\/?/, '');
  const segments = rest.split('/').filter(Boolean);
  const section = segments[0] || 'editor';

  if (section === 'preview') {
    if (!access.canView) return forbidden();
    return preview(request, env, url);
  }

  if (section === 'save') {
    if (!access.canEdit) return forbidden();
    if (request.method !== 'POST') return redirect(`${ADMIN_BASE}/editor`);
    return save(request, env);
  }

  if (section === 'editor') {
    if (!access.canView) return forbidden();
    return editor(env, url, access);
  }

  return redirect(`${ADMIN_BASE}/editor`);
}

async function editor(env: PluginEnv, url: URL, access: ThemeEditorAccess): Promise<Response> {
  const meta = await contentMeta(env);
  const pages = await listReadablePages(env, meta);
  const selectedPage = selectedPageFrom(url, pages);
  const language = selectedLanguage(url, meta.languages, meta.default_language);
  const selectedBlock = selectedBlockFrom(url, selectedPage);
  const pageHref = selectedPage
    ? `${ADMIN_BASE}/editor?page_id=${selectedPage.id}&language=${encodeURIComponent(language)}`
    : `${ADMIN_BASE}/editor`;
  const fields = selectedPage ? editorFields(selectedPage, meta.languages, language, selectedBlock) : [];
  const groups = [...new Set(fields.map((field) => field.group))].map((label) => ({
    label,
    fields: fields.filter((field) => field.group === label),
  }));

  return adminView(env.VIEWS, 'Theme Editor', 'editor', {
    title: env.THEME_NAME || 'Theme Editor',
    description: 'Preview a CMS page in the development theme, select a block, and edit its lect values.',
    canEdit: access.canEdit,
    pages: pages.map((page) => ({
      id: page.id,
      label: `${page.name} · ${page.page_type || 'default'}`,
      selected: page.id === selectedPage?.id,
    })),
    hasPages: pages.length > 0,
    selectedPage,
    pageHref,
    language,
    languages: meta.languages.map((code) => ({ code, selected: code === language })),
    blocks: selectedPage ? blockChoices(selectedPage, selectedBlock, `${ADMIN_BASE}/editor`, language) : [],
    pageSelected: selectedBlock === null,
    pageSettingsHref: pageHref,
    selectedBlock,
    selectedLabel: selectedBlock === null ? 'Page settings' : `Block ${selectedBlock + 1}`,
    fieldGroups: groups,
    hasFields: fields.length > 0,
    loadAction: `${ADMIN_BASE}/editor`,
    saveAction: `${ADMIN_BASE}/save`,
    previewHref: selectedPage
      ? `${ADMIN_BASE}/preview?page_id=${selectedPage.id}&language=${encodeURIComponent(language)}${selectedBlock === null ? '' : `&block=${selectedBlock}`}`
      : '',
    flash: url.searchParams.get('flash') || '',
    nativeEditHref: selectedPage ? `/admin/pages/${selectedPage.id}/edit?editor=cms` : '',
  });
}

async function preview(_request: Request, env: PluginEnv, url: URL): Promise<Response> {
  const id = positiveInt(url.searchParams.get('page_id'));
  if (!id) return new Response('Select a page to preview.', { status: 400 });

  const [meta, page] = await Promise.all([contentMeta(env), cmsClient(env).get(id)]);
  const language = selectedLanguage(url, meta.languages, meta.default_language);
  const selectedBlock = selectedBlockFrom(url, page);
  const cms = cmsClient(env);
  const [settingsResult, newsResult] = await Promise.all([
    meta.page_types.includes('site_settings')
      ? cms.list('site_settings', { limit: 1 }).catch(() => ({ pages: [], total: 0 }))
      : Promise.resolve({ pages: [] as CmsPage[], total: 0 }),
    meta.page_types.includes('news')
      ? cms.list('news', { limit: 12 }).catch(() => ({ pages: [], total: 0 }))
      : Promise.resolve({ pages: [] as CmsPage[], total: 0 }),
  ]);

  const html = await renderThemePreview(env, {
    page,
    settings: settingsResult.pages[0] ?? null,
    pages: [page],
    news: newsResult.pages,
    language,
    languages: meta.languages,
    defaultLanguage: meta.default_language,
    editorHref: `${ADMIN_BASE}/editor?page_id=${page.id}&language=${encodeURIComponent(language)}`,
    selectedBlock,
  });
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-cms-frame': '1',
    },
  });
}

async function save(request: Request, env: PluginEnv): Promise<Response> {
  const form = await request.formData();
  const pageId = positiveInt(form.get('page_id'));
  if (!pageId) return new Response('Invalid page id.', { status: 400 });

  const page = await cmsClient(env).get(pageId);
  const lect = applyEditorFields(page.lect ?? {}, form);
  await updatePageLect(env, pageId, lect, actingUserId(request));

  const language = formString(form.get('language')) || 'mis';
  const block = positiveOrZeroInt(form.get('block'));
  const href = `${ADMIN_BASE}/editor?page_id=${pageId}&language=${encodeURIComponent(language)}`
    + `${block === null ? '' : `&block=${block}`}`
    + `&flash=${encodeURIComponent('Changes saved')}`;
  return redirect(href);
}

export function editorError(env: PluginEnv, error: unknown): Promise<Response> {
  let message = 'The theme editor could not complete this request.';
  if (error instanceof CmsNotConfiguredError) message = error.message;
  if (error instanceof CmsApiError) {
    message = error.status === 403
      ? 'Approve the Theme Editor read/write page-type access in CMS plugin settings.'
      : `CMS responded ${error.status} (${error.code}).`;
  }
  return adminView(env.VIEWS, 'Theme Editor', 'error', {
    heading: 'Theme editor unavailable',
    message,
  });
}

function selectedPageFrom(url: URL, pages: CmsPage[]): CmsPage | null {
  const requested = positiveInt(url.searchParams.get('page_id'));
  return (requested ? pages.find((page) => page.id === requested) : null) ?? pages[0] ?? null;
}

function selectedLanguage(url: URL, languages: string[], fallback: string): string {
  const requested = url.searchParams.get('language')?.trim().toLowerCase() || '';
  return languages.includes(requested) ? requested : fallback || languages[0] || 'mis';
}

function positiveInt(value: FormDataEntryValue | string | null): number | null {
  const parsed = Number.parseInt(typeof value === 'string' ? value : '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveOrZeroInt(value: FormDataEntryValue | null): number | null {
  const parsed = Number.parseInt(typeof value === 'string' ? value : '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function formString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}
