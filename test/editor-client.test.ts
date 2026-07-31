// @vitest-environment happy-dom
// @vitest-environment-options { "settings": { "disableCSSFileLoading": true, "disableJavaScriptFileLoading": true } }
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hostLiquid } from './host-liquid';

/**
 * Drives the approved editor asset against the real `editor.liquid` markup, so
 * the data hooks the script depends on cannot drift from the template that
 * emits them.
 */
const editorAsset = resolve(process.cwd(), 'views/assets/theme-editor.js');
const editorSection = resolve(process.cwd(), 'views/sections/editor.liquid');

function viewData(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Example Theme',
    description: 'Preview a CMS page.',
    themeId: 'example-theme',
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
    pageHref: '/admin/plugins/theme-editor/editor?theme=example-theme',
    language: 'en',
    languages: [{ code: 'en', selected: true }],
    // Matches what the editor route emits: one row per template section, in
    // the order the template renders them.
    sections: [
      {
        key: 'hero',
        type: 'hero',
        label: 'Hero',
        blockIndex: 0,
        blockNumber: 1,
        blockTitle: 'Hello',
        hasBlock: true,
        hidden: false,
        selected: true,
        href: '/admin/plugins/theme-editor/editor?section=hero&block=0',
      },
    ],
    hasSections: true,
    orphanBlocks: [],
    hasOrphanBlocks: false,
    pageSelected: true,
    pageSettingsHref: '/admin/plugins/theme-editor/editor',
    selectedBlock: 0,
    selectedLabel: 'Block 1',
    selectedType: 'hero',
    schemaMode: false,
    schemaName: 'Hero',
    schemaBlock: '0',
    hasSchema: true,
    valuesModeHref: '/admin/plugins/theme-editor/editor?theme=example-theme&block=0',
    schemaModeHref: '/admin/plugins/theme-editor/editor?theme=example-theme&block=0&settings=schema',
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
      themeId: 'example-theme',
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
    previewDataHref: '/admin/plugins/theme-editor/preview/data?theme=example-theme',
    previewBundleHref: '/admin/plugins/theme-editor/preview/bundle?theme=example-theme',
    previewHref: '/admin/plugins/theme-editor/preview?theme=example-theme',
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
    await new (hostLiquid().Liquid)({ outputEscape: 'escape' }).parseAndRender(source, viewData(overrides)),
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

  it('hands a section the page has no block for to the server, which opens it on Schema', async () => {
    // `cta` is the ninth section this template declares, and the page carries
    // one block, so nothing in the page backs it. There are no values to
    // compose here, and the bindings panel is rendered from the theme's own
    // {% schema %}, which only the server can read.
    const assign = vi.fn();
    vi.spyOn(window.location, 'assign').mockImplementation(assign);
    await mountEditor({
      selectedBlock: '',
      selectedSection: '',
      selectedLabel: 'Page settings',
      pageSelected: true,
      schemaBlock: '',
      schemaSection: '',
      sections: [
        {
          key: 'hero', type: 'hero', label: 'Hero', blockIndex: 0, blockNumber: 1,
          blockTitle: 'Hello', hasBlock: true, hidden: false, selected: false,
          href: '/admin/plugins/theme-editor/editor?section=hero&block=0',
        },
        {
          key: 'cta', type: 'cta', label: 'Cta', blockIndex: null, blockNumber: 0,
          blockTitle: '', hasBlock: false, hidden: false, selected: false,
          href: '/admin/plugins/theme-editor/editor?section=cta',
        },
      ],
      editorStateJson: JSON.stringify({
        themeId: 'example-theme',
        templateId: 'page',
        pageId: 12,
        lect: { _type: 'home', _blocks: [{ _id: 'h', _type: 'hero', _weight: 10 }] },
        languages: ['en'],
        language: 'en',
        canEdit: true,
        sections: [
          { key: 'hero', label: 'Hero', type: 'hero', blockIndex: 0 },
          { key: 'cta', label: 'Cta', type: 'cta', blockIndex: null },
        ],
      }),
    });

    const label = document.querySelector('[data-theme-editor-selected-label]') as HTMLElement;
    const section = document.querySelector('[data-theme-editor-selected-section]') as HTMLInputElement;

    const link = document.querySelector('[data-theme-editor-focus][data-section="cta"]') as HTMLAnchorElement;
    link.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    for (let attempt = 0; attempt < 100 && assign.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(assign).toHaveBeenCalledTimes(1);
    expect(String(assign.mock.calls[0]?.[0])).toContain('section=cta');
    // Nothing was composed locally, so the panel still describes what it was
    // rendered for rather than half-describing the section being loaded.
    expect(label.textContent).toBe('Page settings');
    expect(section.value).toBe('');
  });

  it('selects a section the page does have a block for without leaving the page', async () => {
    const assign = vi.fn();
    vi.spyOn(window.location, 'assign').mockImplementation(assign);
    await mountEditor({
      selectedBlock: '',
      selectedSection: '',
      pageSelected: true,
      schemaBlock: '',
      schemaSection: '',
      editorStateJson: JSON.stringify({
        themeId: 'example-theme',
        templateId: 'page',
        pageId: 12,
        lect: { _type: 'home', _blocks: [{ _id: 'h', _type: 'hero', _weight: 10 }] },
        languages: ['en'],
        language: 'en',
        canEdit: true,
        sections: [{ key: 'hero', label: 'Hero', type: 'hero', blockIndex: 0 }],
      }),
    });

    const link = document.querySelector('[data-theme-editor-focus][data-section="hero"]') as HTMLAnchorElement;
    const label = document.querySelector('[data-theme-editor-selected-label]') as HTMLElement;
    link.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    for (let attempt = 0; attempt < 100 && label.textContent !== 'Hero'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // A block backs this one, so it composes here — no load.
    expect(assign).not.toHaveBeenCalled();
    expect(label.textContent).toBe('Hero');
    expect((document.querySelector('[data-theme-editor-selected-section]') as HTMLInputElement).value)
      .toBe('hero');
    expect((document.querySelector('[data-theme-editor-selected-block]') as HTMLInputElement).value)
      .toBe('0');
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

  it('searches the page list and loads the keyboard-selected result', async () => {
    const submit = vi.fn();
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(submit);
    await mountEditor({
      pages: [
        { id: 12, label: 'Home · home', selected: true },
        { id: 25, label: 'Contact us · page', selected: false },
        { id: 31, label: 'Privacy · legal', selected: false },
      ],
    });

    const loadForm = document.querySelector('[data-theme-editor-load]') as HTMLFormElement;
    const pageSelect = loadForm.querySelector('[data-theme-editor-page-select]') as HTMLSelectElement;
    const combobox = loadForm.querySelector('[data-theme-editor-page-combobox]') as HTMLElement;
    const search = combobox.querySelector('[data-theme-editor-page-search]') as HTMLInputElement;

    expect(pageSelect.hidden).toBe(true);
    expect(combobox.hidden).toBe(false);
    expect(search.value).toBe('Home · home');

    search.focus();
    search.value = 'contact';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    const visible = [...combobox.querySelectorAll<HTMLElement>('[data-theme-editor-page-option]')]
      .filter((option) => !option.hidden);
    expect(visible.map((option) => option.textContent?.trim())).toEqual(['Contact us · page']);
    expect(search.getAttribute('aria-expanded')).toBe('true');

    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(pageSelect.value).toBe('25');
    expect(search.value).toBe('Contact us · page');
    expect(search.getAttribute('aria-expanded')).toBe('false');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('confirms before discarding edits and puts the selector back on cancel', async () => {
    const submit = vi.fn();
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(submit);
    await mountEditor({
      pages: [
        { id: 12, label: 'Home · home', selected: true },
        { id: 25, label: 'Contact us · page', selected: false },
      ],
    });

    // Typing into a settings field is what marks the editor dirty.
    const field = document.querySelector('[data-theme-editor-form] [name^="field:/"]');
    if (field) field.dispatchEvent(new Event('input', { bubbles: true }));

    const loadForm = document.querySelector('[data-theme-editor-load]') as HTMLFormElement;
    const pageSelect = loadForm.querySelector('[data-theme-editor-page-select]') as HTMLSelectElement;
    const search = loadForm.querySelector('[data-theme-editor-page-search]') as HTMLInputElement;
    const loaded = pageSelect.value;

    vi.stubGlobal('confirm', vi.fn(() => false));
    search.focus();
    search.value = 'contact';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(submit).not.toHaveBeenCalled();
    // A selector showing a page that was never loaded would misdescribe the
    // editor, so cancelling restores it.
    expect(pageSelect.value).toBe(loaded);
    expect(search.value).toBe('Home · home');
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
