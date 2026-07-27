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
    selectedBlock: 0,
    selectedLabel: 'Block 1',
    selectedType: 'hero',
    schemaMode: false,
    schemaName: 'Hero',
    schemaBlock: '0',
    hasSchema: true,
    valuesModeHref: '/admin/plugins/theme-editor/editor?theme=colorholic-styling&block=0',
    schemaModeHref: '/admin/plugins/theme-editor/editor?theme=colorholic-styling&block=0&settings=schema',
    schemaSettings: [{
      id: 'theme', label: 'Theme', type: 'select',
      binding: '{{ page.blocks[0].theme }}',
      options: [{ value: 'light', label: 'Light', selected: true }],
      hasOptions: true,
      inputName: 'setting:theme', path: '/_blocks/0/theme', overridden: false,
      value: '16-Colour analysis', defaultValue: 'light', multiline: false, editable: true,
    }],
    fieldGroups: [{
      label: 'Block',
      fields: [{
        inputName: 'field:/_blocks/0/title/en',
        label: 'Title',
        path: '/_blocks/0/title/en',
        value: 'Hello',
        badge: 'text',
        multiline: false,
        readOnly: false,
        group: 'Block',
      }],
    }],
    hasFields: true,
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

async function mountEditor(
  overrides: Record<string, unknown> = {},
): Promise<{ renders: RenderCall[]; fetchMock: ReturnType<typeof vi.fn> }> {
  const source = await readFile(editorSection, 'utf8');
  document.body.innerHTML = String(
    await new Liquid({ outputEscape: 'escape' }).parseAndRender(source, viewData(overrides)),
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

  it('shows the settings modes when a block is focused without a reload', async () => {
    // The page itself is selected, which is what the editor opens on when the
    // URL carries no block.
    await mountEditor({ selectedBlock: '', pageSelected: true, schemaBlock: '' });
    const modes = document.querySelector('[data-theme-editor-modes]') as HTMLElement;
    expect(modes.hidden).toBe(true);

    const blockLink = document.querySelector('[data-theme-editor-focus][data-block="0"]') as HTMLAnchorElement;
    blockLink.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    for (let attempt = 0; attempt < 100 && modes.hidden; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Previously these only appeared after a page load, so a locally focused
    // block had settings but no way to reach its schema.
    expect(modes.hidden).toBe(false);
    const schemaLink = modes.querySelector('[data-theme-editor-mode="schema"]') as HTMLAnchorElement;
    const valuesLink = modes.querySelector('[data-theme-editor-mode="values"]') as HTMLAnchorElement;
    // And they point at the block that is actually selected.
    expect(schemaLink.getAttribute('href')).toContain('block=0');
    expect(schemaLink.getAttribute('href')).toContain('settings=schema');
    expect(valuesLink.getAttribute('href')).toContain('block=0');
    expect(valuesLink.getAttribute('href')).not.toContain('settings=schema');
  });

  it('switches between values and schema without leaving the page', async () => {
    await mountEditor();
    const panels = () => Object.fromEntries(
      [...document.querySelectorAll('[data-theme-editor-panel]')].map((panel) => [
        panel.getAttribute('data-theme-editor-panel'),
        { hidden: (panel as HTMLFieldSetElement).hidden, disabled: (panel as HTMLFieldSetElement).disabled },
      ]),
    );

    expect(panels()).toEqual({
      values: { hidden: false, disabled: false },
      schema: { hidden: true, disabled: true },
    });

    const schemaLink = document.querySelector('[data-theme-editor-mode="schema"]') as HTMLAnchorElement;
    const event = new Event('click', { bubbles: true, cancelable: true });
    schemaLink.dispatchEvent(event);

    // No navigation: the panel was already on the page.
    expect(event.defaultPrevented).toBe(true);
    expect(panels()).toEqual({
      values: { hidden: true, disabled: true },
      schema: { hidden: false, disabled: false },
    });
    expect(document.querySelector('[data-theme-editor]')?.getAttribute('data-settings-mode')).toBe('schema');
    expect(window.location.search).toContain('settings=schema');

    const valuesLink = document.querySelector('[data-theme-editor-mode="values"]') as HTMLAnchorElement;
    const back = new Event('click', { bubbles: true, cancelable: true });
    valuesLink.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
    expect(panels().values).toEqual({ hidden: false, disabled: false });
  });

  it('loads the block from the server when the schema panel is for another one', async () => {
    await mountEditor();
    // The server rendered the schema for block 0; selecting another block
    // leaves it describing something that is no longer on screen.
    const selected = document.querySelector('[data-theme-editor-selected-block]') as HTMLInputElement;
    selected.value = '3';

    const schemaLink = document.querySelector('[data-theme-editor-mode="schema"]') as HTMLAnchorElement;
    const event = new Event('click', { bubbles: true, cancelable: true });
    schemaLink.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('updates the hint to what the edited binding resolves to', async () => {
    const resolved: string[] = [];
    await mountEditor();
    (window as unknown as { themeEditorPreview: Record<string, unknown> }).themeEditorPreview.resolve =
      (binding: string) => {
        resolved.push(binding);
        return Promise.resolve(binding === 'hello' ? 'hello' : '16-Colour analysis');
      };

    // The schema fieldset is disabled until its mode is on, so switch first.
    (document.querySelector('[data-theme-editor-mode="schema"]') as HTMLAnchorElement)
      .dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));

    const input = document.querySelector('[data-theme-editor-setting]') as HTMLInputElement;
    const hint = input.parentElement?.querySelector('[data-theme-editor-setting-value]') as HTMLElement;
    expect(hint.textContent?.trim()).toBe('16-Colour analysis');

    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    for (let attempt = 0; attempt < 200 && hint.textContent?.trim() !== 'hello'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // The hint is the binding resolved, so a binding edited to a literal shows
    // that literal rather than the value the setting used to read.
    expect(resolved).toContain('hello');
    expect(hint.textContent?.trim()).toBe('hello');
  });

  it('loads the chosen page, template, or language on change', async () => {
    const submit = vi.fn();
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(submit);
    await mountEditor();

    const loadForm = document.querySelector('[data-theme-editor-load]') as HTMLFormElement;
    const button = loadForm.querySelector('[data-theme-editor-load-button]') as HTMLButtonElement;
    // The submit button is only hidden once this script is driving the form.
    expect(button.hidden).toBe(true);

    const language = loadForm.querySelector('select[name="language"]') as HTMLSelectElement;
    language.dispatchEvent(new Event('change', { bubbles: true }));
    expect(submit).toHaveBeenCalledTimes(1);

    const pageSelect = loadForm.querySelector('select[name="page_id"]') as HTMLSelectElement;
    pageSelect.dispatchEvent(new Event('change', { bubbles: true }));
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('confirms before discarding edits and puts the selector back on cancel', async () => {
    const submit = vi.fn();
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(submit);
    await mountEditor();

    // Typing into a settings field is what marks the editor dirty.
    const field = document.querySelector('[data-theme-editor-form] [name^="field:/"]');
    if (field) field.dispatchEvent(new Event('input', { bubbles: true }));

    const loadForm = document.querySelector('[data-theme-editor-load]') as HTMLFormElement;
    const pageSelect = loadForm.querySelector('select[name="page_id"]') as HTMLSelectElement;
    const loaded = pageSelect.value;
    const option = document.createElement('option');
    option.value = '99';
    pageSelect.appendChild(option);
    pageSelect.value = '99';

    vi.stubGlobal('confirm', vi.fn(() => false));
    pageSelect.dispatchEvent(new Event('change', { bubbles: true }));

    expect(submit).not.toHaveBeenCalled();
    // A selector showing a page that was never loaded would misdescribe the
    // editor, so cancelling restores it.
    expect(pageSelect.value).toBe(loaded);
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
