// @vitest-environment happy-dom
// @vitest-environment-options { "settings": { "disableCSSFileLoading": true, "disableJavaScriptFileLoading": true } }
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Liquid } from 'liquidjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Drives the approved editor asset against the real `editor.liquid` markup, so
 * the data hooks the script depends on cannot drift from the template that
 * emits them.
 */
const editorAsset = resolve(process.cwd(), 'views/assets/theme-editor.js');
const editorSection = resolve(process.cwd(), 'views/sections/editor.liquid');

function viewData(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Colorholic Styling',
    description: 'Preview a CMS page.',
    themeId: 'colorholic-styling',
    templateId: 'page',
    templates: [{ id: 'page', label: 'Page', selected: true }],
    dashboardHref: '/admin/plugins/theme-editor',
    canEdit: true,
    pages: [{ id: 12, label: 'Home · home', selected: true }],
    hasPages: true,
    visibilityAction: '/admin/plugins/theme-editor/visibility',
    looseSections: [],
    hasLooseSections: false,
    selectedPage: { id: 12, name: 'Home' },
    pageHref: '/admin/plugins/theme-editor/editor?theme=colorholic-styling',
    language: 'en',
    languages: [{ code: 'en', selected: true }],
    blocks: [
      {
        index: 0,
        type: 'hero',
        label: 'Hello',
        selected: false,
        href: '/admin/plugins/theme-editor/editor?block=0',
        sectionKey: 'hero',
        sectionHidden: false,
      },
    ],
    pageSelected: true,
    pageSettingsHref: '/admin/plugins/theme-editor/editor',
    selectedBlock: null,
    selectedLabel: 'Page settings',
    selectedType: '',
    fieldGroups: [],
    hasFields: false,
    loadAction: '/admin/plugins/theme-editor/editor',
    editorStateJson: JSON.stringify({
      themeId: 'colorholic-styling',
      templateId: 'page',
      pageId: 12,
      lect: { _type: 'home', _blocks: [{ _id: 'h', _type: 'hero', _weight: 10 }] },
      languages: ['en'],
      language: 'en',
      canEdit: true,
    }),
    saveAction: '/admin/plugins/theme-editor/save',
    assetHref: '/admin/plugins/theme-editor/assets/theme-editor.js',
    previewAssetHref: '/admin/plugins/theme-editor/assets/theme-preview.js',
    previewDataHref: '/admin/plugins/theme-editor/preview/data?theme=colorholic-styling',
    previewBundleHref: '/admin/plugins/theme-editor/preview/bundle?theme=colorholic-styling',
    previewHref: '/admin/plugins/theme-editor/preview?theme=colorholic-styling',
    flash: '',
    nativeEditHref: '',
    ...overrides,
  };
}

interface RenderCall { hidden?: string[] }

async function mountEditor(): Promise<{ renders: RenderCall[]; fetchMock: ReturnType<typeof vi.fn> }> {
  const source = await readFile(editorSection, 'utf8');
  document.body.innerHTML = String(
    await new Liquid({ outputEscape: 'escape' }).parseAndRender(source, viewData()),
  );

  const renders: RenderCall[] = [];
  (window as unknown as { themeEditorPreview: unknown }).themeEditorPreview = {
    render: (update: RenderCall = {}) => {
      renders.push(update);
      return Promise.resolve();
    },
  };

  const fetchMock = vi.fn(async () => new Response(
    JSON.stringify({ ok: true, section: 'hero', hidden: ['hero'], message: 'Hidden hero' }),
    { headers: { 'content-type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', fetchMock);

  new Function(await readFile(editorAsset, 'utf8'))();
  return { renders, fetchMock };
}

function visibilityForm(): HTMLFormElement {
  const form = document.querySelector('[data-theme-editor-visibility]');
  if (!form) throw new Error('No visibility form rendered');
  return form as HTMLFormElement;
}

describe('editor page visibility toggle', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as { themeEditorPreview?: unknown }).themeEditorPreview;
  });

  it('toggles a section in place and redraws the frame instead of reloading', async () => {
    const { renders, fetchMock } = await mountEditor();
    const form = visibilityForm();
    const button = form.querySelector('[data-theme-editor-visibility-button]') as HTMLButtonElement;
    const value = form.querySelector('[data-theme-editor-visibility-value]') as HTMLInputElement;
    const flag = form.parentElement?.querySelector('[data-theme-editor-hidden-flag]') as HTMLElement;

    expect(button.textContent?.trim()).toBe('Hide');
    expect(value.value).toBe('1');
    expect(flag.hidden).toBe(true);

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    for (let attempt = 0; attempt < 100 && renders.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/visibility');
    // The row now offers the way back, and the frame was redrawn from the
    // returned set rather than reloaded.
    expect(button.textContent?.trim()).toBe('Show');
    expect(button.disabled).toBe(false);
    expect(value.value).toBe('0');
    expect(flag.hidden).toBe(false);
    expect(renders).toEqual([{ hidden: ['hero'] }]);
  });

  it('leaves the plain form post alone when the frame cannot be redrawn here', async () => {
    const { renders, fetchMock } = await mountEditor();
    delete (window as unknown as { themeEditorPreview?: unknown }).themeEditorPreview;

    const event = new Event('submit', { bubbles: true, cancelable: true });
    visibilityForm().dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Without a renderer the toggle has to reach the server the normal way.
    expect(event.defaultPrevented).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(renders).toEqual([]);
  });
});
