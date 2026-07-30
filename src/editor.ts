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
import { themeRuntimeSettings } from './theme/renderer';
import { applyOverridesToTemplate } from './theme/publish';
import { buildThemeManifest } from './theme/manifest';
import { schemaFields, sectionSchema } from './theme/schema';
import {
  GitHubClient,
  GitHubError,
  parseRepo,
  repoFromFullName,
  repoFromUrl,
  type GitHubRepo,
} from './theme/github';
import {
  disconnectGitHubApp,
  githubAccess,
  githubAppDashboard,
  githubInstallUrl,
} from './theme/github-app';
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
    if (segments[1] === 'connect') return connectGitHubApp(request, env);
    if (segments[1] === 'disconnect') return disconnectGitHub(request, env);
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
  // Repository names may be private. A view-only CMS user can see themes but
  // must not cause an installation token to be minted or receive GitHub
  // connection metadata in the client-view payload.
  const githubDashboard = access.canEdit
    ? githubAppDashboard(env)
    : Promise.resolve({
      configured: false,
      configurationMessage: '',
      connected: false,
      connection: null,
      repositories: [],
      error: '',
    });
  const [themes, github] = await Promise.all([
    availableThemes(env),
    githubDashboard,
  ]);
  return adminView(env.VIEWS, 'Theme Editor', 'themes', {
    title: 'Themes',
    description: 'Choose an available theme to preview and edit its CMS page content.',
    themes: themes.map((theme) => ({
      ...theme,
      editorHref: themeEditorHref(theme),
      canPush: Boolean(theme.repo),
    })),
    canEdit: access.canEdit,
    hasGitHubToken: access.canEdit && Boolean(env.GITHUB_TOKEN),
    githubAppConfigured: github.configured,
    githubAppConfigurationMessage: github.configurationMessage,
    githubConnected: github.connected,
    githubAccount: github.connection?.accountLogin ?? '',
    githubAccountType: github.connection?.accountType ?? '',
    githubRepositorySelection: github.connection?.repositorySelection ?? '',
    githubManageHref: github.connection?.manageUrl ?? '',
    githubRepositories: github.repositories,
    githubError: github.error,
    githubConnectAction: `${ADMIN_BASE}/github/connect`,
    githubDisconnectAction: `${ADMIN_BASE}/github/disconnect`,
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
  // A theme with no usable template has nowhere better to send the reader:
  // redirecting to the editor is redirecting to this very URL, which is a
  // redirect loop rather than an error. Say what is wrong instead.
  if (!selectedTemplate) {
    return adminView(env.VIEWS, 'Theme Editor', 'error', {
      heading: `${theme.name} has no templates`,
      message: url.searchParams.get('template')
        ? `This theme declares no template named "${url.searchParams.get('template')}".`
        : 'Its manifest lists no templates, so there is nothing to render. A theme '
          + 'needs JSON or Liquid files under templates/; re-clone or re-upload it '
          + 'if that directory was missing when it landed.',
    });
  }
  const language = selectedLanguage(url, meta.languages, meta.default_language);
  const [sections, overrides] = await Promise.all([
    templateSections(selectedTemplate, store),
    templateOverrides(env, theme.id, selectedTemplate.id),
  ]);
  const hidden = new Set(overrides.hidden);
  const sectionByBlock = new Map(sections
    .filter((entry) => entry.blockIndex !== null)
    .map((entry) => [entry.blockIndex as number, entry]));

  // The template is what says which sections a page has, so the list is drawn
  // from it. A section whose block the page has not been given yet still
  // belongs on it — that is exactly the section an editor needs to reach to
  // hide it, or to see what the theme would render there.
  const requestedSection = url.searchParams.get('section')?.trim() ?? '';
  const urlBlock = selectedBlockFrom(url, selectedPage);
  const activeSection = (requestedSection
    ? sections.find((entry) => entry.key === requestedSection)
    : urlBlock === null ? undefined : sectionByBlock.get(urlBlock)) ?? null;
  // Selecting a section selects the block it reads, when the page has one.
  const selectedBlock = urlBlock
    ?? blockIndexOnPage(selectedPage, activeSection?.blockIndex ?? null);

  const editorBase = themeEditorHref(theme, selectedTemplate.id);
  const pageHref = selectedPage
    ? `${editorBase}&page_id=${selectedPage.id}&language=${encodeURIComponent(language)}`
    : editorBase;
  const fields = selectedPage ? editorFields(selectedPage, meta.languages, language, selectedBlock) : [];
  const groups = fieldGroups(fields);
  const choices = selectedPage
    ? blockChoices(selectedPage, selectedBlock, editorBase, language)
    : [];
  const blockByIndex = new Map(choices.map((block) => [block.index, block]));
  const selectedType = activeSection?.type
    || (selectedBlock === null ? '' : blockByIndex.get(selectedBlock)?.type ?? '');
  const sectionRows = sections.map((entry) => {
    const block = entry.blockIndex === null ? undefined : blockByIndex.get(entry.blockIndex);
    return {
      key: entry.key,
      label: entry.label,
      type: entry.type,
      /** The block the template binds this section to, if the page has it. */
      blockIndex: block ? block.index : null,
      blockNumber: block ? block.index + 1 : 0,
      blockTitle: block?.label ?? '',
      hasBlock: Boolean(block),
      hidden: hidden.has(entry.key),
      selected: activeSection?.key === entry.key,
      href: `${pageHref}&section=${encodeURIComponent(entry.key)}`
        + `${block ? `&block=${block.index}` : ''}`,
    };
  });
  // Blocks the template reads through no declared section would otherwise have
  // no row, so they keep one of their own rather than becoming uneditable.
  const boundBlocks = new Set(sections.flatMap((entry) => entry.blockIndex === null
    ? []
    : [entry.blockIndex]));
  const orphanBlocks = choices.filter((block) => !boundBlocks.has(block.index));

  // Settings mode reads the section's own `{% schema %}`, so labels, controls,
  // and the Liquid a JSON template would bind come from the theme rather than
  // from the shape of whatever happens to be stored.
  // Both panels are rendered whichever mode is requested, so switching between
  // them is a client-side toggle rather than a page load.
  // A selected section the page has no block for has nothing in the values
  // panel, so it opens on its bindings rather than on an empty form.
  const missingBlock = activeSection !== null && selectedBlock === null;
  const schemaMode = missingBlock || url.searchParams.get('settings') === 'schema';
  const schema = selectedType ? await sectionSchema(store, selectedType) : null;
  // The schema panel edits the bindings of the selected template section, so it
  // needs that section's declared settings and any override. A section the page
  // has no block for still has both, which is why this no longer waits on one.
  const schemaSettings = schema
    ? schemaFields(
      schema,
      fields,
      selectedBlock ?? activeSection?.blockIndex ?? 0,
      language,
      activeSection?.settings ?? {},
      activeSection ? overrides.settings[activeSection.key] ?? {} : {},
    )
    : [];
  const modeHref = (mode: 'values' | 'schema'): string => `${editorBase}`
    + `${selectedPage ? `&page_id=${selectedPage.id}` : ''}`
    + `&language=${encodeURIComponent(language)}`
    + `${activeSection ? `&section=${encodeURIComponent(activeSection.key)}` : ''}`
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
    sections: sectionRows,
    hasSections: sectionRows.length > 0,
    orphanBlocks,
    hasOrphanBlocks: orphanBlocks.length > 0,
    selectedPage,
    pageHref,
    language,
    languages: meta.languages.map((code) => ({ code, selected: code === language })),
    pageSelected: selectedBlock === null && activeSection === null,
    pageSettingsHref: pageHref,
    selectedBlock,
    selectedSection: activeSection?.key ?? '',
    selectedLabel: activeSection?.label
      ?? (selectedBlock === null ? 'Page settings' : `Block ${selectedBlock + 1}`),
    selectedType,
    fieldGroups: groups,
    hasFields: fields.length > 0,
    /** Hides the Values mode, which such a section has nothing to put in. */
    missingBlock,
    schemaMode,
    schemaAction: `${ADMIN_BASE}/template-settings`,
    schemaSection: activeSection?.key ?? '',
    canEditSchema: access.canEdit && Boolean(activeSection),
    schemaName: schema?.name ?? '',
    schemaSettings,
    hasSchema: schemaSettings.length > 0,
    /** What the schema panel describes, so a stale one is not shown. */
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
      // The list is the template's, so composing a panel in the browser needs
      // the same section list the server drew it from.
      sections: sectionRows.map((entry) => ({
        key: entry.key,
        label: entry.label,
        type: entry.type,
        blockIndex: entry.blockIndex,
      })),
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
  const ready = await gitHubClient(env);
  if (ready instanceof Response) return ready;

  const url = formString(form.get('url'));
  const fromUrl = url ? repoFromUrl(url) : null;
  const fromSelection = repoFromFullName(formString(form.get('repository')));
  const requestedBranch = formString(form.get('branch'));
  const owner = formString(form.get('owner')) || fromSelection?.owner || fromUrl?.owner;
  const repoName = formString(form.get('repo')) || fromSelection?.repo || fromUrl?.repo;
  let branch = requestedBranch;
  if (!branch && fromSelection && owner && repoName) {
    try {
      branch = await ready.client.defaultBranch(owner, repoName);
    } catch (error) {
      return githubResult(request, false, gitHubMessage(error));
    }
  }
  const repo = parseRepo({
    owner,
    repo: repoName,
    branch,
    path: formString(form.get('path')),
  });
  if (!repo) return githubResult(request, false, 'Enter a GitHub repository, or paste its URL.');

  const themeId = (formString(form.get('theme_id')) || repo.repo).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(themeId)) {
    return githubResult(request, false, 'Theme id must be lowercase letters, numbers, and dashes.');
  }

  try {
    const files = await ready.client.readTheme(repo);
    if (files.length === 0) {
      return githubResult(request, false, `No theme files found under ${repo.path || 'the repository root'}.`);
    }

    const store = new R2ThemeStore(env.THEMES as R2Bucket, themeId);
    for (const file of files) await store.write(file.path, file.content);
    // A theme repository has no manifest — it is a build product — so one is
    // generated from what arrived. Without it the theme lands with no
    // templates at all. The repo goes in too, so pushing needs no second setup.
    await store.write('/theme-manifest.json', buildThemeManifest(
      files.map((file) => file.path),
      { ...themeMetaFrom(files.find((file) => file.path === '/theme-manifest.json')?.content), repo },
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
  const ready = await gitHubClient(env);
  if (ready instanceof Response) return ready;

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
    const sha = await ready.client.commit(
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

/** GitHub work needs either an App installation or a PAT, plus an R2 bucket. */
async function gitHubClient(env: PluginEnv): Promise<{ client: GitHubClient } | Response> {
  if (!env.THEMES) {
    return Response.json({
      ok: false,
      message: 'No themes bucket is bound, so there is nowhere to put a cloned theme.',
    }, { status: 503 });
  }
  try {
    const access = await githubAccess(env);
    if (!access) {
      return Response.json({
        ok: false,
        message: 'Connect GitHub from the theme dashboard, or set `GITHUB_TOKEN` with '
          + '`wrangler secret put GITHUB_TOKEN` (Contents: read and write).',
      }, { status: 503 });
    }
    return { client: new GitHubClient(access.token) };
  } catch (error) {
    return Response.json({
      ok: false,
      message: gitHubMessage(error),
    }, { status: 503 });
  }
}

async function connectGitHubApp(request: Request, env: PluginEnv): Promise<Response> {
  try {
    const location = await githubInstallUrl(env, actingUserId(request));
    return new Response(null, {
      status: 302,
      headers: { location, 'cache-control': 'no-store' },
    });
  } catch (error) {
    return githubResult(request, false, gitHubMessage(error));
  }
}

async function disconnectGitHub(request: Request, env: PluginEnv): Promise<Response> {
  await disconnectGitHubApp(env);
  return githubResult(
    request,
    true,
    'Disconnected GitHub from this CMS. The GitHub App remains installed until you remove it on GitHub.',
  );
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

/** A theme's own naming, when its repository happens to carry a manifest. */
function themeMetaFrom(existing: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(existing ?? '{}') as unknown;
    if (!isRecord(parsed)) return {};
    const { name, description } = parsed;
    return {
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof description === 'string' ? { description } : {}),
    };
  } catch {
    return {};
  }
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
  // Regenerated from what actually landed, so an upload missing the manifest —
  // or carrying a stale one — still yields a usable theme.
  if (written.length > 0 && !written.includes('/theme-manifest.json')) {
    await store.write('/theme-manifest.json', buildThemeManifest(written));
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

/** The index back, only when the page actually carries that block. */
function blockIndexOnPage(page: CmsPage | null, index: number | null): number | null {
  if (!page || index === null) return null;
  const blocks = page.lect?._blocks;
  return Array.isArray(blocks) && isRecord(blocks[index]) ? index : null;
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
