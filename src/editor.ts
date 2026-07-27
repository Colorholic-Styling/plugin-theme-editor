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
import { themeBundle } from './theme/bundle';
import {
  applyEditorFields,
  blockChoices,
  editorFields,
  selectedBlockFrom,
} from './editor-model';
import { previewThemeStore, renderThemePreview, themeRuntime } from './theme/colorholic';
import { AssetThemeStore } from './theme/store';
import {
  hiddenSections,
  MissingOverrideStoreError,
  setSectionHidden,
} from './theme/overrides';
import { selectThemeTemplate, templateSections, themeTemplates } from './theme/templates';
import {
  availableThemes,
  themeEditorHref,
  themeFromId,
  type ThemeDefinition,
} from './themes';
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
  const section = segments[0] || 'themes';

  if (section === 'themes') {
    if (!access.canView) return forbidden();
    return themesDashboard(env);
  }

  if (section === 'preview') {
    if (!access.canView) return forbidden();
    const theme = themeFromId(env, url.searchParams.get('theme'));
    if (!theme) return new Response('Theme not found.', { status: 404 });
    if (segments[1] === 'bundle') {
      return Response.json(await themeBundle(env, theme), {
        headers: { 'cache-control': 'no-store' },
      });
    }
    return preview(request, env, url, theme);
  }

  if (section === 'visibility') {
    if (!access.canEdit) return forbidden();
    if (request.method !== 'POST') return redirect(`${ADMIN_BASE}/editor`);
    return toggleSectionVisibility(request, env);
  }

  if (section === 'save') {
    if (!access.canEdit) return forbidden();
    if (request.method !== 'POST') return redirect(`${ADMIN_BASE}/editor`);
    return save(request, env);
  }

  if (section === 'editor') {
    if (!access.canView) return forbidden();
    const theme = themeFromId(env, url.searchParams.get('theme'));
    if (!theme) return redirect(ADMIN_BASE);
    return editor(env, url, access, theme);
  }

  return redirect(ADMIN_BASE);
}

function themesDashboard(env: PluginEnv): Promise<Response> {
  return adminView(env.VIEWS, 'Theme Editor', 'themes', {
    title: 'Themes',
    description: 'Choose an available theme to preview and edit its CMS page content.',
    themes: availableThemes(env).map((theme) => ({
      ...theme,
      editorHref: themeEditorHref(theme),
    })),
  });
}

async function editor(
  env: PluginEnv,
  url: URL,
  access: ThemeEditorAccess,
  theme: ThemeDefinition,
): Promise<Response> {
  const meta = await contentMeta(env);
  const pages = await listReadablePages(env, meta);
  const selectedPage = selectedPageFrom(url, pages);
  const templates = await themeTemplates(env, theme);
  const selectedTemplate = selectThemeTemplate(
    templates,
    url.searchParams.get('template'),
    selectedPage?.page_type ?? '',
  );
  if (!selectedTemplate) return redirect(themeEditorHref(theme));
  const language = selectedLanguage(url, meta.languages, meta.default_language);
  const selectedBlock = selectedBlockFrom(url, selectedPage);
  const [sections, hidden] = await Promise.all([
    templateSections(env, theme, selectedTemplate),
    hiddenSections(env, theme.id, selectedTemplate.id),
  ]);
  const sectionByBlock = new Map(sections
    .filter((entry) => entry.blockIndex !== null)
    .map((entry) => [entry.blockIndex as number, entry]));
  const editorBase = themeEditorHref(theme, selectedTemplate.id);
  const pageHref = selectedPage
    ? `${editorBase}&page_id=${selectedPage.id}&language=${encodeURIComponent(language)}`
    : editorBase;
  const fields = selectedPage ? editorFields(selectedPage, meta.languages, language, selectedBlock) : [];
  const groups = fieldGroups(fields);
  const choices = selectedPage
    ? blockChoices(selectedPage, selectedBlock, editorBase, language)
    : [];
  const selectedType = selectedBlock === null
    ? ''
    : choices.find((block) => block.index === selectedBlock)?.type ?? '';
  // A block row carries the toggle for the section bound to it; sections bound
  // to no block are listed separately so every declared section is reachable.
  const blockRows = choices.map((block) => {
    const bound = sectionByBlock.get(block.index);
    return {
      ...block,
      sectionKey: bound?.key ?? '',
      sectionHidden: bound ? hidden.has(bound.key) : false,
    };
  });
  const boundKeys = new Set([...sectionByBlock.values()].map((entry) => entry.key));
  const looseSections = sections
    .filter((entry) => !boundKeys.has(entry.key))
    .map((entry) => ({ ...entry, hidden: hidden.has(entry.key) }));

  return adminView(env.VIEWS, 'Theme Editor', 'editor', {
    title: theme.name,
    description: 'Preview a CMS page in the development theme, select a block, and edit its lect values.',
    themeId: theme.id,
    templateId: selectedTemplate.id,
    templates: templates.map((template) => ({
      id: template.id,
      label: template.label,
      selected: template.id === selectedTemplate.id,
    })),
    dashboardHref: ADMIN_BASE,
    canEdit: access.canEdit,
    pages: pages.map((page) => ({
      id: page.id,
      label: `${page.name} · ${page.page_type || 'default'}`,
      selected: page.id === selectedPage?.id,
    })),
    hasPages: pages.length > 0,
    visibilityAction: `${ADMIN_BASE}/visibility`,
    looseSections,
    hasLooseSections: looseSections.length > 0,
    selectedPage,
    pageHref,
    language,
    languages: meta.languages.map((code) => ({ code, selected: code === language })),
    blocks: blockRows,
    pageSelected: selectedBlock === null,
    pageSettingsHref: pageHref,
    selectedBlock,
    selectedLabel: selectedBlock === null ? 'Page settings' : `Block ${selectedBlock + 1}`,
    selectedType,
    fieldGroups: groups,
    hasFields: fields.length > 0,
    loadAction: `${ADMIN_BASE}/editor`,
    editorStateJson: selectedPage ? JSON.stringify({
      themeId: theme.id,
      templateId: selectedTemplate.id,
      pageId: selectedPage.id,
      lect: selectedPage.lect ?? {},
      languages: meta.languages,
      language,
      canEdit: access.canEdit,
    }) : '{}',
    saveAction: `${ADMIN_BASE}/save`,
    assetHref: `${ADMIN_BASE}/assets/theme-editor.js`,
    previewHref: selectedPage
      ? `${ADMIN_BASE}/preview?theme=${encodeURIComponent(theme.id)}&template=${encodeURIComponent(selectedTemplate.id)}&page_id=${selectedPage.id}&language=${encodeURIComponent(language)}${selectedBlock === null ? '' : `&block=${selectedBlock}`}`
      : '',
    flash: url.searchParams.get('flash') || '',
    nativeEditHref: selectedPage ? `/admin/pages/${selectedPage.id}/edit?editor=cms` : '',
  });
}

async function preview(
  _request: Request,
  env: PluginEnv,
  url: URL,
  theme: ThemeDefinition,
): Promise<Response> {
  const id = positiveInt(url.searchParams.get('page_id'));
  if (!id) return new Response('Select a page to preview.', { status: 400 });

  const [meta, page] = await Promise.all([contentMeta(env), cmsClient(env).get(id)]);
  const templates = await themeTemplates(env, theme);
  const selectedTemplate = selectThemeTemplate(
    templates,
    url.searchParams.get('template'),
    page.page_type ?? '',
  );
  if (!selectedTemplate) return new Response('Theme template not found.', { status: 404 });
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

  const renderContext = {
    page,
    settings: settingsResult.pages[0] ?? null,
    pages: [page],
    news: newsResult.pages,
    language,
    languages: meta.languages,
    defaultLanguage: meta.default_language,
    editorHref: `${themeEditorHref(theme, selectedTemplate.id)}&page_id=${page.id}&language=${encodeURIComponent(language)}`,
    selectedBlock,
  };
  const hidden = await hiddenSections(env, theme.id, selectedTemplate.id);
  const runtime = themeRuntime(env, previewThemeStore(new AssetThemeStore(env.VIEWS, theme.assetPrefix)));
  const html = theme.renderer === 'colorholic'
    ? await renderThemePreview(runtime, renderContext, selectedTemplate, hidden)
    : '';
  return new Response(withBrowserRenderer(html, {
    context: renderContext,
    template: selectedTemplate,
    hidden: [...hidden],
    runtime: { siteTitle: runtime.siteTitle, bookingUrl: runtime.bookingUrl, assetVersion: runtime.assetVersion },
    bundleHref: `${ADMIN_BASE}/preview/bundle?theme=${encodeURIComponent(theme.id)}`,
  }), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-cms-frame': '1',
    },
  });
}

/**
 * Hands the browser renderer everything the Worker just used, so it can redraw
 * the same page locally. The server-rendered HTML above stays the first paint:
 * it is what shows while this loads, and all there is if the asset is not
 * approved.
 */
function withBrowserRenderer(html: string, bootstrap: unknown): string {
  if (!html.includes('</body>')) return html;
  // `</script>` anywhere inside the JSON would close the tag early, so keep `<`
  // out of the text entirely.
  const payload = JSON.stringify(bootstrap).replaceAll('<', '\\u003c');
  return html.replace('</body>', ''
    + `<script type="application/json" data-theme-preview-bootstrap>${payload}</script>`
    + `<script src="${ADMIN_BASE}/assets/theme-preview.js" defer></script>`
    + '</body>');
}

/**
 * Section visibility is stored per theme template, so it applies to every page
 * that template renders — unlike the block values `save` writes, which belong
 * to one page.
 */
async function toggleSectionVisibility(request: Request, env: PluginEnv): Promise<Response> {
  const form = await request.formData();
  const theme = themeFromId(env, formString(form.get('theme')) || null);
  if (!theme) return new Response('Theme not found.', { status: 404 });

  const templates = await themeTemplates(env, theme);
  const selectedTemplate = selectThemeTemplate(templates, formString(form.get('template')) || null);
  if (!selectedTemplate) return new Response('Theme template not found.', { status: 404 });

  // Only keys the template actually declares may be written, so a crafted post
  // cannot fill the override with junk the editor would then have to display.
  const sectionKey = formString(form.get('section'));
  const sections = await templateSections(env, theme, selectedTemplate);
  if (!sections.some((entry) => entry.key === sectionKey)) {
    return new Response('Theme section not found.', { status: 404 });
  }

  const hide = formString(form.get('hidden')) === '1';
  let flash = hide ? `Hidden ${sectionKey}` : `Shown ${sectionKey}`;
  try {
    await setSectionHidden(env, theme.id, selectedTemplate.id, sectionKey, hide);
  } catch (error) {
    if (!(error instanceof MissingOverrideStoreError)) throw error;
    flash = error.message;
  }

  // Deliberately no `block`: toggling visibility is not a request to edit that
  // block, and any block in the URL opens the settings panel over the list the
  // toggle was just used from.
  const pageId = positiveInt(form.get('page_id'));
  const language = formString(form.get('language')) || 'mis';
  const href = `${themeEditorHref(theme, selectedTemplate.id)}`
    + `${pageId ? `&page_id=${pageId}` : ''}`
    + `&language=${encodeURIComponent(language)}`
    + `&flash=${encodeURIComponent(flash)}`;
  return redirect(href);
}

async function save(request: Request, env: PluginEnv): Promise<Response> {
  const form = await request.formData();
  const theme = themeFromId(env, formString(form.get('theme')) || null);
  if (!theme) {
    return acceptsJson(request)
      ? Response.json({ ok: false, message: 'Theme not found.' }, { status: 404 })
      : new Response('Theme not found.', { status: 404 });
  }
  const pageId = positiveInt(form.get('page_id'));
  if (!pageId) {
    return acceptsJson(request)
      ? Response.json({ ok: false, message: 'Invalid page id.' }, { status: 400 })
      : new Response('Invalid page id.', { status: 400 });
  }

  const page = await cmsClient(env).get(pageId);
  const templates = await themeTemplates(env, theme);
  const selectedTemplate = selectThemeTemplate(
    templates,
    formString(form.get('template')) || null,
    page.page_type ?? '',
  );
  if (!selectedTemplate) {
    return acceptsJson(request)
      ? Response.json({ ok: false, message: 'Theme template not found.' }, { status: 404 })
      : new Response('Theme template not found.', { status: 404 });
  }
  const lect = applyEditorFields(page.lect ?? {}, form);
  await updatePageLect(env, pageId, lect, actingUserId(request));

  const language = formString(form.get('language')) || 'mis';
  const block = positiveOrZeroInt(form.get('block'));
  if (acceptsJson(request)) {
    return Response.json({
      ok: true,
      message: 'Changes saved',
      themeId: theme.id,
      templateId: selectedTemplate.id,
      pageId,
      block,
      lect,
    });
  }

  const href = `${themeEditorHref(theme, selectedTemplate.id)}&page_id=${pageId}&language=${encodeURIComponent(language)}`
    + `${block === null ? '' : `&block=${block}`}`
    + `&flash=${encodeURIComponent('Changes saved')}`;
  return redirect(href);
}

function acceptsJson(request: Request): boolean {
  return request.headers.get('accept')?.includes('application/json') === true
    || request.headers.get('x-requested-with') === 'XMLHttpRequest';
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

function fieldGroups<T extends { group: string }>(fields: T[]): Array<{ label: string; fields: T[] }> {
  return [...new Set(fields.map((field) => field.group))].map((label) => ({
    label,
    fields: fields.filter((field) => field.group === label),
  }));
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
