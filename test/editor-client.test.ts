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

/** Who the CMS reports as editing this page; set by the presence tests. */
let presenceRoster: unknown[] = [];
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
    sectionSchemaAction: '/admin/plugins/theme-editor/section-schema',
    // Off unless a test asks for it: the heartbeat would otherwise show up in
    // every assertion about what this page sends.
    hasPresence: false,
    presencePageId: '12',
    presenceUserId: '42',
    presenceUserName: 'Ada Lovelace',
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
): Promise<{ renders: RenderCall[]; fetchMock: ReturnType<typeof vi.fn>; sockets: FakeSocket[] }> {
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

  // The bindings panel is composed from the theme's own {% schema %}, so the
  // browser asks the server for it rather than loading the whole page again.
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const href = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (href.includes('/admin/api/presence/')) {
      return new Response(JSON.stringify(presenceRoster), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (href.includes('/section-schema')) {
      const requested = new URL(href, 'https://cms.example.com');
      return new Response(JSON.stringify({
        ok: true,
        section: requested.searchParams.get('section') ?? '',
        block: requested.searchParams.get('block') === null
          ? null
          : Number(requested.searchParams.get('block')),
        schemaName: 'Fetched schema',
        schemaSettings: [{
          id: 'headline',
          label: 'Headline',
          type: 'text',
          binding: '{{ page.blocks[1].headline }}',
          inputName: 'setting:headline',
          value: 'Fetched value',
          editable: true,
        }],
        hasSchema: true,
        missingBlock: requested.searchParams.get('block') === null,
        canEditSchema: true,
      }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(
      JSON.stringify({ ok: true, section: 'hero', hidden: ['hero'], message: 'Hidden hero' }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchMock);

  // Presence rides the CMS's own editing session over a WebSocket; nothing in
  // these tests reaches a real one.
  const sockets: FakeSocket[] = [];
  vi.stubGlobal('WebSocket', class {
    static OPEN = 1;
    readyState = 1;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    sent: string[] = [];
    constructor(public url: string) {
      sockets.push(this as unknown as FakeSocket);
    }
    send(data: string) {
      this.sent.push(data);
    }
  });

  new Function(await readFile(editorAsset, 'utf8'))();
  return { renders, fetchMock, sockets };
}

interface FakeSocket {
  url: string;
  readyState: number;
  sent: string[];
  onmessage: ((event: { data: string }) => void) | null;
}

function visibilityForm(): HTMLFormElement {
  const form = document.querySelector('[data-theme-editor-visibility]');
  if (!form) throw new Error('No visibility form rendered');
  return form as HTMLFormElement;
}

describe('editor page visibility toggle', () => {
  beforeEach(() => {
  presenceRoster = [];
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

  it('opens a section the page has no block for on Schema, without leaving the page', async () => {
    // `cta` is a section the page carries no block for, so there are no values
    // to compose and it opens on its bindings. Those come from the theme's own
    // {% schema %}, which the browser has no copy of — it fetches one rather
    // than reloading and discarding the selection.
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
    const root = document.querySelector('[data-theme-editor]') as HTMLElement;

    const link = document.querySelector('[data-theme-editor-focus][data-section="cta"]') as HTMLAnchorElement;
    link.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    for (let attempt = 0; attempt < 100 && root.getAttribute('data-settings-mode') !== 'schema'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(assign).not.toHaveBeenCalled();
    expect(root.getAttribute('data-settings-mode')).toBe('schema');
    expect(label.textContent).toBe('Cta');
    expect(section.value).toBe('cta');

    // The panel shows the fetched bindings, and the Values tab is out of reach
    // because this section has no block to put values in.
    const input = document.querySelector('[data-theme-editor-setting]') as HTMLInputElement;
    expect(input.value).toBe('{{ page.blocks[1].headline }}');
    expect((document.querySelector('[data-theme-editor-mode="values"]') as HTMLElement).hidden).toBe(true);
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

  it('re-reads the bindings when the rendered panel is for another block', async () => {
    const assign = vi.fn();
    vi.spyOn(window.location, 'assign').mockImplementation(assign);
    const { fetchMock } = await mountEditor();
    // The server rendered the schema for block 0; selecting another block
    // leaves it describing something that is no longer on screen.
    const selected = document.querySelector('[data-theme-editor-selected-block]') as HTMLInputElement;
    selected.value = '3';

    const schemaLink = document.querySelector('[data-theme-editor-mode="schema"]') as HTMLAnchorElement;
    const event = new Event('click', { bubbles: true, cancelable: true });
    schemaLink.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    const input = () => document.querySelector('[data-theme-editor-setting]') as HTMLInputElement;
    for (let attempt = 0; attempt < 100 && input().value !== '{{ page.blocks[1].headline }}'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Fetched for the block now selected, and shown in place — the page was
    // never reloaded, so nothing else on it was lost.
    expect(assign).not.toHaveBeenCalled();
    const requested = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(requested.some((href) => href.includes('/section-schema') && href.includes('block=3'))).toBe(true);
    expect(input().value).toBe('{{ page.blocks[1].headline }}');
  });

  it('shows only the newest bindings when selections are changed quickly', async () => {
    // Two requests in flight: a slow first answer must not land last and leave
    // the panel describing a section nobody is looking at.
    const { fetchMock } = await mountEditor();
    const root = document.querySelector('[data-theme-editor]') as HTMLElement;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const href = String(input);
      const requested = new URL(href, 'https://cms.example.com');
      const section = requested.searchParams.get('section') ?? '';
      if (section === 'hero') await new Promise((resolve) => setTimeout(resolve, 40));
      return new Response(JSON.stringify({
        ok: true,
        section,
        block: 0,
        schemaName: section,
        schemaSettings: [{
          id: 'headline', label: 'Headline', type: 'text',
          binding: `binding-for-${section}`,
          inputName: 'setting:headline', value: '', editable: true,
        }],
        hasSchema: true,
        missingBlock: false,
        canEditSchema: true,
      }), { headers: { 'content-type': 'application/json' } });
    });

    const schemaLink = document.querySelector('[data-theme-editor-mode="schema"]') as HTMLAnchorElement;
    const selectedSection = document.querySelector('[data-theme-editor-selected-section]') as HTMLInputElement;
    const selectedBlock = document.querySelector('[data-theme-editor-selected-block]') as HTMLInputElement;

    selectedSection.value = 'hero';
    selectedBlock.value = '3';
    schemaLink.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    selectedSection.value = 'cta';
    schemaLink.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(root.getAttribute('data-settings-mode')).toBe('schema');
    const input = document.querySelector('[data-theme-editor-setting]') as HTMLInputElement;
    expect(input.value).toBe('binding-for-cta');
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

  it('shows who else has this page open', async () => {
    presenceRoster = [
      { user_id: '42', user_name: 'Ada Lovelace', last_active: new Date().toISOString() },
      { user_id: '77', user_name: 'Grace Hopper', last_active: new Date().toISOString() },
      // Long gone from the keyboard: still here, but shown as idle.
      { user_id: '99', user_name: 'Old Timer', last_active: new Date(Date.now() - 3.6e6).toISOString() },
    ];
    const { fetchMock } = await mountEditor({ hasPresence: true });
    const host = document.querySelector('[data-theme-editor-presence]') as HTMLElement;

    // The heartbeat goes to the CMS's own presence endpoint for this page, so
    // someone in the native editor and someone here appear to each other.
    const posted = fetchMock.mock.calls.find((call) => (call[1] as RequestInit)?.method === 'POST');
    expect(String(posted?.[0])).toBe('/admin/api/presence/12');

    for (let attempt = 0; attempt < 100 && host.children.length < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect([...host.children].map((node) => node.textContent)).toEqual(['AL', 'GH', 'OT']);
    expect((host.children[0] as HTMLElement).title).toContain('(you)');
    expect((host.children[2] as HTMLElement).title).toContain('(idle)');
    expect((host.children[2] as HTMLElement).style.opacity).toBe('0.4');
  });

  it('outlines the field another editor is in, and lets go when they leave', async () => {
    const { sockets } = await mountEditor({ hasPresence: true });
    const socket = sockets[0];
    expect(socket.url).toContain('/admin/api/sync/12');

    const field = document.querySelector('[name="field:/_blocks/0/title/en"]') as HTMLInputElement;
    expect(field.style.outline).toBe('');

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'focus',
        path: 'field:/_blocks/0/title/en',
        userId: '77',
        userName: 'Grace Hopper',
      }),
    });
    expect(field.style.outline).toContain('2px');
    expect(field.title).toBe('Grace Hopper is editing this');

    socket.onmessage?.({
      data: JSON.stringify({ type: 'blur', path: 'field:/_blocks/0/title/en', userId: '77' }),
    });
    expect(field.style.outline).toBe('');
    expect(field.title).toBe('');
  });

  it('tells other editors which field it is in, but never sends an edit', async () => {
    const { sockets } = await mountEditor({ hasPresence: true });
    const socket = sockets[0];
    const field = document.querySelector('[name="field:/_blocks/0/title/en"]') as HTMLInputElement;

    field.dispatchEvent(new Event('focusin', { bubbles: true }));
    field.value = 'edited here';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('focusout', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const types = socket.sent.map((raw) => JSON.parse(raw).type);
    expect(types).toEqual(['focus', 'blur']);
    // An `op` would join the shared overlay of uncommitted edits, which the
    // CMS's own save route commits — and this editor saves through the plugin
    // API instead, so nothing would ever clear it.
    expect(types).not.toContain('op');
  });

  it('re-outlines a field after the panel is redrawn', async () => {
    const { sockets } = await mountEditor({
      hasPresence: true,
      // The composed panel has to produce this field again, so the page has to
      // actually carry it.
      editorStateJson: JSON.stringify({
        themeId: 'example-theme',
        templateId: 'page',
        pageId: 12,
        lect: {
          _type: 'home',
          _blocks: [{ _id: 'h', _type: 'hero', _weight: 10, title: { en: 'Hello' } }],
        },
        languages: ['en'],
        language: 'en',
        canEdit: true,
      }),
    });
    sockets[0].onmessage?.({
      data: JSON.stringify({
        type: 'focus',
        path: 'field:/_blocks/0/title/en',
        userId: '77',
        userName: 'Grace Hopper',
      }),
    });

    // Focusing another section rebuilds the panel from scratch: the highlight
    // belongs to the field, not to the element that was showing it.
    const link = document.querySelector('[data-theme-editor-focus][data-section="hero"]') as HTMLAnchorElement;
    link.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const field = document.querySelector('[name="field:/_blocks/0/title/en"]') as HTMLInputElement;
    expect(field.style.outline).toContain('2px');
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
