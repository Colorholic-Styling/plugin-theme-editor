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
import { themeRuntimeSettings } from './theme/colorholic';
import { applyOverridesToTemplate } from './theme/publish';
import { schemaFields, sectionSchema } from './theme/schema';
import {
  GitHubClient,
  GitHubError,
  parseRepo,
  repoFromUrl,
  type GitHubRepo,
} from './theme/github';
import { isWritable, R2ThemeStore } from './theme/store';

import {
  allTemplateOverrides,
  clearTemplateOverrides,
  hiddenSections,
  MissingOverrideStoreError,
  setSectionHidden,
  setSectionSettings,
  templateOverrides,
} from './theme/overrides';
import { selectThemeTemplate, templateSections, themeTemplates } from './theme/templates';
import {
  availableThemes,
  themeEditorHref,
  themeFromId,
  themeStore,
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
    return themesDashboard(env, url, access);
  }

  if (section === 'preview') {
    if (!access.canView) return forbidden();
    const theme = await themeFromId(env, url.searchParams.get('theme'));
    if (!theme) return new Response('Theme not found.', { status: 404 });
    if (segments[1] === 'bundle') {
      return Response.json(await themeBundle(env, theme), {
        headers: { 'cache-control': 'no-store' },
      });
    }
    if (segments[1] === 'data') return previewData(env, url, theme);
    return preview();
  }

  if (section === 'visibility') {
    if (!access.canEdit) return forbidden();
    if (request.method !== 'POST') return redirect(`${ADMIN_BASE}/editor`);
    return toggleSectionVisibility(request, env);
  }

  // Read and clear the override layer. A Worker cannot write to the theme's
  // own files, so `npm run theme:apply` runs on the machine that can, reads
  // this, writes the templates, and clears what it applied.
  if (section === 'overrides') {
    const theme = await themeFromId(env, url.searchParams.get('theme'));
    if (!theme) return new Response('Theme not found.', { status: 404 });
    if (segments[1] === 'clear') {
      if (!access.canEdit) return forbidden();
      if (request.method !== 'POST') return new Response('POST required.', { status: 405 });
      return clearOverrides(request, env, theme);
    }
    if (!access.canView) return forbidden();
    const templates = await themeTemplates(env, theme, themeStore(env, theme));
    return Response.json({
      theme: theme.id,
      templates: await allTemplateOverrides(env, theme.id, templates.map((entry) => entry.id)),
    }, { headers: { 'cache-control': 'no-store' } });
  }

  // Publishing writes the override layer into the theme itself, which only a
  // bucket-backed theme allows — an asset binding is immutable at runtime, and
  // there `npm run theme:apply` does the same job from the machine that has
  // the theme checked out.
  // Uploading a theme folder into the bucket. `theme:sync --push` uses this,
  // so the same path works against local R2 in `wrangler dev` and the real
  // bucket in production.
  // Cloning a theme from GitHub and committing it back. Both go through the
  // Git Data API: a Worker has no git binary, and this makes a push atomic.
  if (section === 'github') {
    if (!access.canEdit) return forbidden();
    if (request.method !== 'POST') return redirect(ADMIN_BASE);
    return segments[1] === 'push'
      ? pushThemeToGitHub(request, env)
      : cloneThemeFromGitHub(request, env);
  }

  if (section === 'upload') {
    if (!access.canEdit) return forbidden();
    if (request.method !== 'POST') return new Response('POST required.', { status: 405 });
    return uploadTheme(request, env, url);
  }

  if (section === 'publish') {
    if (!access.canEdit) return forbidden();
    if (request.method !== 'POST') return redirect(`${ADMIN_BASE}/editor`);
    return publishTheme(request, env);
  }

  if (section === 'template-settings') {
    if (!access.canEdit) return forbidden();
    if (request.method !== 'POST') return redirect(`${ADMIN_BASE}/editor`);
    return saveTemplateSettings(request, env);
  }

  if (section === 'save') {
    if (!access.canEdit) return forbidden();
    if (request.method !== 'POST') return redirect(`${ADMIN_BASE}/editor`);
    return save(request, env);
  }

  if (section === 'editor') {
    if (!access.canView) return forbidden();
    const theme = await themeFromId(env, url.searchParams.get('theme'));
    if (!theme) return redirect(ADMIN_BASE);
    return editor(env, url, access, theme);
  }

  return redirect(ADMIN_BASE);
}

async function themesDashboard(
  env: PluginEnv,
  url: URL,
  access: ThemeEditorAccess,
): Promise<Response> {
  const themes = await availableThemes(env);
  return adminView(env.VIEWS, 'Theme Editor', 'themes', {
    title: 'Themes',
    description: 'Choose an available theme to preview and edit its CMS page content.',
    themes: themes.map((theme) => ({
      ...theme,
      editorHref: themeEditorHref(theme),
      canPush: Boolean(theme.repo),
    })),
    canEdit: access.canEdit,
    hasGitHubToken: Boolean(env.GITHUB_TOKEN),
    cloneAction: `${ADMIN_BASE}/github`,
    pushAction: `${ADMIN_BASE}/github/push`,
    flash: url.searchParams.get('flash') || '',
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
  const store = themeStore(env, theme);
  const templates = await themeTemplates(env, theme, store);
  const selectedTemplate = selectThemeTemplate(
    templates,
    url.searchParams.get('template'),
    selectedPage?.page_type ?? '',
  );
  if (!selectedTemplate) return redirect(themeEditorHref(theme));
  const language = selectedLanguage(url, meta.languages, meta.default_language);
  const selectedBlock = selectedBlockFrom(url, selectedPage);
  const [sections, overrides] = await Promise.all([
    templateSections(selectedTemplate, store),
    templateOverrides(env, theme.id, selectedTemplate.id),
  ]);
  const hidden = new Set(overrides.hidden);
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

  // Settings mode reads the section's own `{% schema %}`, so labels, controls,
  // and the Liquid a JSON template would bind come from the theme rather than
  // from the shape of whatever happens to be stored.
  // Both panels are rendered whichever mode is requested, so switching between
  // them is a client-side toggle rather than a page load.
  const schemaMode = url.searchParams.get('settings') === 'schema';
  const schema = selectedBlock !== null && selectedType
    ? await sectionSchema(store, selectedType)
    : null;
  // The schema panel edits the bindings of the template section bound to this
  // block, so it needs that section's declared settings and any override.
  const boundSection = selectedBlock === null ? undefined : sectionByBlock.get(selectedBlock);
  const schemaSettings = schema
    ? schemaFields(
      schema,
      fields,
      selectedBlock ?? 0,
      language,
      boundSection?.settings ?? {},
      boundSection ? overrides.settings[boundSection.key] ?? {} : {},
    )
    : [];
  const modeHref = (mode: 'values' | 'schema'): string => `${editorBase}`
    + `${selectedPage ? `&page_id=${selectedPage.id}` : ''}`
    + `&language=${encodeURIComponent(language)}`
    + `${selectedBlock === null ? '' : `&block=${selectedBlock}`}`
    + `${mode === 'schema' ? '&settings=schema' : ''}`;

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
    schemaMode,
    schemaAction: `${ADMIN_BASE}/template-settings`,
    schemaSection: boundSection?.key ?? '',
    canEditSchema: access.canEdit && Boolean(boundSection),
    schemaName: schema?.name ?? '',
    schemaSettings,
    hasSchema: schemaSettings.length > 0,
    /** Which block the schema panel describes, so a stale one is not shown. */
    schemaBlock: selectedBlock === null ? '' : String(selectedBlock),
    valuesModeHref: modeHref('values'),
    schemaModeHref: modeHref('schema'),
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
    previewAssetHref: `${ADMIN_BASE}/assets/theme-preview.js`,
    previewDataHref: selectedPage
      ? `${ADMIN_BASE}/preview/data?theme=${encodeURIComponent(theme.id)}&template=${encodeURIComponent(selectedTemplate.id)}&page_id=${selectedPage.id}&language=${encodeURIComponent(language)}${selectedBlock === null ? '' : `&block=${selectedBlock}`}`
      : '',
    previewBundleHref: `${ADMIN_BASE}/preview/bundle?theme=${encodeURIComponent(theme.id)}`,
    previewHref: selectedPage
      ? `${ADMIN_BASE}/preview?theme=${encodeURIComponent(theme.id)}&template=${encodeURIComponent(selectedTemplate.id)}&page_id=${selectedPage.id}&language=${encodeURIComponent(language)}${selectedBlock === null ? '' : `&block=${selectedBlock}`}`
      : '',
    flash: url.searchParams.get('flash') || '',
    nativeEditHref: selectedPage ? `/admin/pages/${selectedPage.id}/edit?editor=cms` : '',
  });
}

/**
 * An empty document for the editor page to draw into. It carries no script of
 * its own on purpose: the host strips every `<script>` from a plugin HTML
 * document and only restores approved ones inside a client view, so nothing
 * here could ever run. The renderer lives in the editor page instead and writes
 * the theme into this frame across the same origin.
 */
function preview(): Response {
  return new Response(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Theme preview</title>
<link rel="stylesheet" href="${ADMIN_BASE}/theme/assets/site.css">
<style>.theme-preview-status{margin:0;padding:24px;font:500 14px/1.5 system-ui;color:#6b7280}</style>
</head>
<body>
<p class="theme-preview-status" data-theme-preview-status>Loading preview…</p>
</body>
</html>`, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-cms-frame': '1',
    },
  });
}

/** Everything the browser renderer needs to draw the page, as JSON. */
async function previewData(
  env: PluginEnv,
  url: URL,
  theme: ThemeDefinition,
): Promise<Response> {
  const id = positiveInt(url.searchParams.get('page_id'));
  if (!id) return Response.json({ error: 'page_id required' }, { status: 400 });

  const [meta, page] = await Promise.all([contentMeta(env), cmsClient(env).get(id)]);
  const store = themeStore(env, theme);
  const templates = await themeTemplates(env, theme, store);
  const selectedTemplate = selectThemeTemplate(
    templates,
    url.searchParams.get('template'),
    page.page_type ?? '',
  );
  if (!selectedTemplate) return Response.json({ error: 'template not found' }, { status: 404 });
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
  const overrides = await templateOverrides(env, theme.id, selectedTemplate.id);
  return Response.json({
    context: renderContext,
    template: selectedTemplate,
    hidden: overrides.hidden,
    settingOverrides: overrides.settings,
    runtime: themeRuntimeSettings(env),
  }, { headers: { 'cache-control': 'no-store' } });
}

/**
 * Section visibility is stored per theme template, so it applies to every page
 * that template renders — unlike the block values `save` writes, which belong
 * to one page.
 */
async function toggleSectionVisibility(request: Request, env: PluginEnv): Promise<Response> {
  const form = await request.formData();
  const theme = await themeFromId(env, formString(form.get('theme')) || null);
  if (!theme) return new Response('Theme not found.', { status: 404 });

  const store = themeStore(env, theme);
  const templates = await themeTemplates(env, theme, store);
  const selectedTemplate = selectThemeTemplate(templates, formString(form.get('template')) || null);
  if (!selectedTemplate) return new Response('Theme template not found.', { status: 404 });

  // Only keys the template actually declares may be written, so a crafted post
  // cannot fill the override with junk the editor would then have to display.
  const sectionKey = formString(form.get('section'));
  const sections = await templateSections(selectedTemplate, store);
  if (!sections.some((entry) => entry.key === sectionKey)) {
    return new Response('Theme section not found.', { status: 404 });
  }

  const hide = formString(form.get('hidden')) === '1';
  let flash = hide ? `Hidden ${sectionKey}` : `Shown ${sectionKey}`;
  let hidden: string[] = [];
  try {
    hidden = await setSectionHidden(env, theme.id, selectedTemplate.id, sectionKey, hide);
  } catch (error) {
    if (!(error instanceof MissingOverrideStoreError)) throw error;
    if (acceptsJson(request)) {
      return Response.json({ ok: false, message: error.message }, { status: 503 });
    }
    flash = error.message;
  }

  // The editor page redraws the frame from this set, so a toggle costs no
  // reload of either the page or the preview.
  if (acceptsJson(request)) {
    return Response.json({ ok: true, section: sectionKey, hidden, message: flash });
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

/**
 * Writes what a template section's settings bind to. This edits the theme
 * template rather than the page, so unlike `save` it touches no CMS content —
 * the change applies to every page the template renders.
 */
/**
 * Writes every template's overrides into the theme's own files and clears what
 * was applied, so the theme becomes the only thing saying what it says.
 */
/** Reads a repository's theme directory into the bucket as a theme folder. */
async function cloneThemeFromGitHub(request: Request, env: PluginEnv): Promise<Response> {
  const form = await request.formData();
  const gate = gitHubReady(env);
  if (gate) return gate;

  const url = formString(form.get('url'));
  const fromUrl = url ? repoFromUrl(url) : null;
  const repo = parseRepo({
    owner: formString(form.get('owner')) || fromUrl?.owner,
    repo: formString(form.get('repo')) || fromUrl?.repo,
    branch: formString(form.get('branch')),
    path: formString(form.get('path')),
  });
  if (!repo) return githubResult(request, false, 'Enter a GitHub repository, or paste its URL.');

  const themeId = (formString(form.get('theme_id')) || repo.repo).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(themeId)) {
    return githubResult(request, false, 'Theme id must be lowercase letters, numbers, and dashes.');
  }

  try {
    const client = new GitHubClient(env.GITHUB_TOKEN as string);
    const files = await client.readTheme(repo);
    if (files.length === 0) {
      return githubResult(request, false, `No theme files found under ${repo.path || 'the repository root'}.`);
    }

    const store = new R2ThemeStore(env.THEMES as R2Bucket, themeId);
    for (const file of files) await store.write(file.path, file.content);
    // The manifest carries the repo, so pushing later needs no second setup.
    await store.write('/theme-manifest.json', themeManifestWith(
      files.find((file) => file.path === '/theme-manifest.json')?.content,
      repo,
    ));
    return githubResult(request, true,
      `Cloned ${files.length} files from ${repo.owner}/${repo.repo}@${repo.branch} into ${themeId}.`);
  } catch (error) {
    return githubResult(request, false, gitHubMessage(error));
  }
}

/** Commits the theme's templates back to the repository it was cloned from. */
async function pushThemeToGitHub(request: Request, env: PluginEnv): Promise<Response> {
  const form = await request.formData();
  const gate = gitHubReady(env);
  if (gate) return gate;

  const theme = await themeFromId(env, formString(form.get('theme')) || null);
  if (!theme) return githubResult(request, false, 'Theme not found.');
  if (!theme.repo) {
    return githubResult(request, false, 'This theme was not cloned from GitHub, so there is nowhere to push it.');
  }

  const store = themeStore(env, theme);
  const templates = await themeTemplates(env, theme, store);
  const files = await Promise.all(templates.map(async (template) => ({
    path: template.path,
    content: await store.read(template.path),
  })));

  try {
    const client = new GitHubClient(env.GITHUB_TOKEN as string);
    const sha = await client.commit(
      theme.repo,
      files,
      formString(form.get('message')) || `Update theme templates from the CMS theme editor`,
    );
    return githubResult(request, true,
      `Pushed ${files.length} templates to ${theme.repo.owner}/${theme.repo.repo}@${theme.repo.branch} (${sha.slice(0, 7)}).`);
  } catch (error) {
    return githubResult(request, false, gitHubMessage(error));
  }
}

/** GitHub work needs both a token to act with and a bucket to land in. */
function gitHubReady(env: PluginEnv): Response | null {
  if (!env.GITHUB_TOKEN) {
    return Response.json({
      ok: false,
      message: 'No GitHub token. Set one with `wrangler secret put GITHUB_TOKEN` '
        + '(a fine-grained token with Contents: read and write).',
    }, { status: 503 });
  }
  if (!env.THEMES) {
    return Response.json({
      ok: false,
      message: 'No themes bucket is bound, so there is nowhere to put a cloned theme.',
    }, { status: 503 });
  }
  return null;
}

function gitHubMessage(error: unknown): string {
  if (error instanceof GitHubError) return error.message;
  return error instanceof Error ? error.message : 'The GitHub request failed.';
}

function githubResult(request: Request, ok: boolean, message: string): Response {
  if (acceptsJson(request)) {
    return Response.json({ ok, message }, { status: ok ? 200 : 400 });
  }
  return redirect(`${ADMIN_BASE}?flash=${encodeURIComponent(message)}`);
}

/** Keeps the theme's own manifest, adding where it came from. */
function themeManifestWith(existing: string | undefined, repo: GitHubRepo): string {
  let manifest: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(existing ?? '{}') as unknown;
    if (isRecord(parsed)) manifest = parsed;
  } catch {
    manifest = {};
  }
  return `${JSON.stringify({ ...manifest, repo }, null, 2)}\n`;
}

async function uploadTheme(request: Request, env: PluginEnv, url: URL): Promise<Response> {
  if (!env.THEMES) {
    return Response.json({
      ok: false,
      message: 'No themes bucket is bound. Add an [[r2_buckets]] binding named THEMES.',
    }, { status: 503 });
  }
  const themeId = (url.searchParams.get('theme') || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(themeId)) {
    return Response.json({ ok: false, message: 'Invalid theme id.' }, { status: 400 });
  }

  const files = await request.json() as unknown;
  if (!isRecord(files)) {
    return Response.json({ ok: false, message: 'Expected a { path: source } object.' }, { status: 400 });
  }

  const store = new R2ThemeStore(env.THEMES, themeId);
  const written: string[] = [];
  for (const [path, source] of Object.entries(files)) {
    // Paths come from an upload, so they decide bucket keys: keep traversal
    // and anything but a theme file out of them.
    if (typeof source !== 'string') continue;
    if (!/^\/[a-z0-9][a-z0-9./_-]*$/i.test(path) || path.includes('..')) continue;
    await store.write(path, source);
    written.push(path);
  }
  return Response.json({ ok: true, theme: themeId, written: written.length, paths: written.sort() });
}

async function publishTheme(request: Request, env: PluginEnv): Promise<Response> {
  const form = await request.formData();
  const theme = await themeFromId(env, formString(form.get('theme')) || null);
  if (!theme) return Response.json({ ok: false, message: 'Theme not found.' }, { status: 404 });

  const store = themeStore(env, theme);
  if (!isWritable(store)) {
    return Response.json({
      ok: false,
      message: 'This theme is served from an immutable asset bundle. '
        + 'Bind a themes bucket, or run `npm run theme:apply` where it is checked out.',
    }, { status: 409 });
  }

  const templates = await themeTemplates(env, theme, store);
  const overrides = await allTemplateOverrides(env, theme.id, templates.map((entry) => entry.id));
  const published: Array<{ template: string; changes: string[] }> = [];

  for (const [templateId, layer] of Object.entries(overrides)) {
    const template = templates.find((entry) => entry.id === templateId);
    if (!template || template.format !== 'json') continue;
    const { next, changes } = applyOverridesToTemplate(
      JSON.parse(await store.read(template.path)),
      layer,
    );
    if (changes.length === 0) continue;
    await store.write(template.path, `${JSON.stringify(next, null, 2)}\n`);
    // Cleared only after the write landed, so a failure leaves the edit in the
    // editor rather than losing it between the two.
    await clearTemplateOverrides(env, theme.id, templateId);
    published.push({ template: templateId, changes });
  }

  return Response.json({ ok: true, theme: theme.id, published });
}

async function clearOverrides(
  request: Request,
  env: PluginEnv,
  theme: ThemeDefinition,
): Promise<Response> {
  const form = await request.formData();
  const store = themeStore(env, theme);
  const templates = await themeTemplates(env, theme, store);
  const templateId = formString(form.get('template'));
  if (!templates.some((entry) => entry.id === templateId)) {
    return Response.json({ ok: false, message: 'Theme template not found.' }, { status: 404 });
  }
  try {
    await clearTemplateOverrides(env, theme.id, templateId);
  } catch (error) {
    if (!(error instanceof MissingOverrideStoreError)) throw error;
    return Response.json({ ok: false, message: error.message }, { status: 503 });
  }
  return Response.json({ ok: true, template: templateId });
}

async function saveTemplateSettings(request: Request, env: PluginEnv): Promise<Response> {
  const form = await request.formData();
  const theme = await themeFromId(env, formString(form.get('theme')) || null);
  if (!theme) return new Response('Theme not found.', { status: 404 });

  const store = themeStore(env, theme);
  const templates = await themeTemplates(env, theme, store);
  const selectedTemplate = selectThemeTemplate(templates, formString(form.get('template')) || null);
  if (!selectedTemplate) return new Response('Theme template not found.', { status: 404 });

  const sectionKey = formString(form.get('section'));
  const sections = await templateSections(selectedTemplate, store);
  const target = sections.find((entry) => entry.key === sectionKey);
  if (!target) return new Response('Theme section not found.', { status: 404 });

  // Only what the section's schema declares may be written, so a crafted post
  // cannot introduce settings the section does not have.
  const schema = await sectionSchema(store, target.type);
  const allowed = new Set((schema?.settings ?? []).map((setting) => setting.id));
  const settings: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (!name.startsWith('setting:') || typeof value !== 'string') continue;
    const id = name.slice('setting:'.length);
    if (!allowed.has(id)) continue;
    const binding = value.trim();
    // Only what differs from the theme's own template is stored. Recording a
    // binding the theme already declares would freeze it, so a later edit to
    // the theme file would be masked by an override saying the same thing.
    if (binding && binding !== target.settings[id]) settings[id] = binding;
  }

  let message = `Updated ${sectionKey} bindings`;
  let saved: Record<string, string> = settings;
  try {
    const next = await setSectionSettings(env, theme.id, selectedTemplate.id, sectionKey, settings);
    saved = next.settings[sectionKey] ?? {};
  } catch (error) {
    if (!(error instanceof MissingOverrideStoreError)) throw error;
    if (acceptsJson(request)) {
      return Response.json({ ok: false, message: error.message }, { status: 503 });
    }
    message = error.message;
  }

  if (acceptsJson(request)) {
    // The whole map goes back so the preview can be redrawn from it directly.
    const next = await templateOverrides(env, theme.id, selectedTemplate.id);
    return Response.json({
      ok: true,
      section: sectionKey,
      settings: saved,
      settingOverrides: next.settings,
      message,
    });
  }

  const pageId = positiveInt(form.get('page_id'));
  const language = formString(form.get('language')) || 'mis';
  const block = positiveOrZeroInt(form.get('block'));
  return redirect(`${themeEditorHref(theme, selectedTemplate.id)}`
    + `${pageId ? `&page_id=${pageId}` : ''}`
    + `&language=${encodeURIComponent(language)}`
    + `${block === null ? '' : `&block=${block}`}`
    + '&settings=schema'
    + `&flash=${encodeURIComponent(message)}`);
}

async function save(request: Request, env: PluginEnv): Promise<Response> {
  const form = await request.formData();
  const theme = await themeFromId(env, formString(form.get('theme')) || null);
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
  const store = themeStore(env, theme);
  const templates = await themeTemplates(env, theme, store);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}
