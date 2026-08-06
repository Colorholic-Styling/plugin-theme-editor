// @vitest-environment happy-dom
// @vitest-environment-options { "settings": { "disableCSSFileLoading": true, "disableJavaScriptFileLoading": true } }
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Exercises the built asset rather than the source module, because what ships
 * is the bundle: a browser build that failed to resolve LiquidJS, or pulled in
 * something only the Worker has, would still pass a source-level test.
 */
const bundlePath = resolve(process.cwd(), 'views/assets/theme-preview.js');
const themePath = resolve(process.cwd(), 'test/fixtures/theme');

async function themeBundle(): Promise<Record<string, string>> {
  const manifest = JSON.parse(
    await readFile(`${themePath}/theme-manifest.json`, 'utf8'),
  ) as { files: string[] };
  const entries = await Promise.all(manifest.files.map(async (file) =>
    [file, await readFile(`${themePath}${file}`, 'utf8')] as const));
  return Object.fromEntries(entries);
}

const DATA_HREF = '/admin/plugins/theme-editor/preview/data?theme=example-theme&template=page&page_id=12';
const BUNDLE_HREF = '/admin/plugins/theme-editor/preview/bundle?theme=example-theme';

function previewData(overrides: Record<string, unknown> = {}) {
  return {
    context: {
      page: {
        id: 12,
        name: 'Home',
        page_type: 'home',
        created_at: '2026-07-01T00:00:00Z',
        lect: {
          _type: 'home',
          title: { en: 'Welcome' },
          _blocks: [
            {
              _id: 'hero-1',
              _type: 'hero',
              _weight: 10,
              theme: 'cream',
              title: { en: 'Hello from the browser' },
              body: { en: '<p>Editable copy.</p>' },
              primary: { label: { en: 'Book' }, url: { en: '/book' } },
            },
          ],
        },
      },
      settings: null,
      pages: [],
      news: [],
      language: 'en',
      languages: ['en', 'zh-hant'],
      defaultLanguage: 'en',
      editorHref: '/admin/plugins/theme-editor/editor?theme=example-theme&template=page&page_id=12',
      selectedBlock: 0,
    },
    template: { id: 'page', label: 'Page', path: '/templates/page.json', format: 'json' },
    hidden: [],
    runtime: {
      themeId: 'example-theme',
      siteTitle: 'Preview site',
      bookingUrl: 'https://book.example.com',
      assetVersion: 'dev',
    },
    ...overrides,
  };
}

interface PreviewApi {
  render(update?: {
    lect?: Record<string, unknown>;
    fields?: FormData;
    selectedBlock?: number | null;
    hidden?: string[];
  }): Promise<void>;
}

/**
 * Mirrors the editor page: the renderer runs here and the preview is a
 * same-origin frame it writes into, because the host strips scripts out of the
 * preview document itself.
 */
/** What the Worker serves into the frame before anything is drawn. */
const SHELL = '<p class="theme-preview-status" data-theme-preview-status>Loading preview…</p>';

function mountFrame(withShell = true): HTMLIFrameElement {
  document.body.innerHTML = '';
  const host = document.createElement('iframe');
  host.setAttribute('data-theme-editor-preview', '');
  host.setAttribute('data-theme-editor-preview-data', DATA_HREF);
  host.setAttribute('data-theme-editor-preview-bundle', BUNDLE_HREF);
  document.body.appendChild(host);
  if (withShell && host.contentDocument) host.contentDocument.body.innerHTML = SHELL;
  return host;
}

async function startPreview(data: Record<string, unknown> = previewData()): Promise<PreviewApi> {
  const host = mountFrame();

  // The frame is served empty, so the renderer has to fetch both the page and
  // the theme before it can paint anything.
  const files = await themeBundle();
  const fetchMock = vi.fn(async (href: string) => new Response(
    JSON.stringify(href.startsWith(BUNDLE_HREF.split('?')[0]) ? files : data),
    { headers: { 'content-type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', fetchMock);

  const source = await readFile(bundlePath, 'utf8');
  new Function(source)();
  void host;

  const win = window as unknown as { themeEditorPreview?: PreviewApi };
  for (let attempt = 0; attempt < 400 && !previewHtml().includes('hero'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!win.themeEditorPreview) throw new Error('Browser preview renderer did not start');
  return win.themeEditorPreview;
}

/** The markup the renderer wrote into the frame. */
function previewHtml(): string {
  const host = document.querySelector('[data-theme-editor-preview]') as HTMLIFrameElement | null;
  return host?.contentDocument?.body?.innerHTML ?? '';
}

function previewHead(): string {
  const host = document.querySelector('[data-theme-editor-preview]') as HTMLIFrameElement | null;
  return host?.contentDocument?.head?.innerHTML ?? '';
}

describe('browser preview renderer', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as { themeEditorPreview?: unknown }).themeEditorPreview;
  });

  it('paints the empty frame from the JSON page and the theme bundle', async () => {
    await startPreview();

    // No further render call: the frame arrives empty and the first paint is
    // the renderer's own work.
    expect(previewHtml()).toContain('hero hero--cream');
    expect(previewHtml()).not.toContain('Loading preview');
    // The theme's head comes from the render too, not from the frame.
    expect(previewHead()).toContain('site.css');
    expect(previewHead()).toContain('pointer-events:none');
    expect(previewHead()).toContain('pointer-events:auto');
    expect(previewHtml()).toContain('Hello from the browser');
    expect(previewHtml()).toContain('data-theme-editor-field="field:/_blocks/0/title/en"');
    // The selection overlay is part of the shared renderer, so it must survive
    // the trip through the browser build too.
    expect(previewHtml()).toContain('data-theme-editor-block="0"');
    expect(previewHtml()).toContain('theme-editor-block is-selected');
  });

  it('addresses the page and the theme with a stamp no cache can already hold', async () => {
    await startPreview();

    const calls = (globalThis.fetch as unknown as {
      mock: { calls: Array<[string, RequestInit]> };
    }).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [href, init] of calls) {
      // The theme lives in a bucket that changes on every push, while these
      // URLs name a theme rather than a version of it — so without this a
      // cached copy is served as the current theme.
      expect(new URL(href, 'https://cms.local').searchParams.get('r')).toMatch(/^\d+$/);
      expect(init.cache).toBe('no-store');
    }
  });

  it('re-renders edited fields without touching the network', async () => {
    const preview = await startPreview();
    const requestsBefore = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    const fields = new FormData();
    fields.append('field:/_blocks/0/title/en', 'Typed live');
    await preview.render({ fields });

    expect(previewHtml()).toContain('Typed live');
    expect(previewHtml()).not.toContain('Hello from the browser');
    const requestsAfter = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(requestsAfter).toBe(requestsBefore);
    // Both loads happen once, at start-up.
    expect(requestsBefore).toBe(2);
  });

  it('moves the selection overlay without a reload', async () => {
    const preview = await startPreview();
    await preview.render({ selectedBlock: null });
    expect(previewHtml()).not.toContain('theme-editor-block is-selected');

    await preview.render({ selectedBlock: 0 });
    expect(previewHtml()).toContain('theme-editor-block is-selected');
  });

  it('drops a hidden section from the compiled order', async () => {
    const preview = await startPreview();
    expect(previewHtml()).toContain('hero hero--cream');

    await preview.render({ hidden: ['hero'] });
    expect(previewHtml()).not.toContain('hero hero--cream');
  });

  it('waits for the frame to commit instead of drawing into its blank document', async () => {
    // A warm cache runs this script before the frame's navigation commits, so
    // the frame still holds the blank document every iframe starts with — which
    // already reports readyState "complete". Drawing there put the theme
    // somewhere the real document then replaced, leaving the placeholder.
    const host = mountFrame(false);
    const files = await themeBundle();
    vi.stubGlobal('fetch', vi.fn(async (href: string) => new Response(
      JSON.stringify(href.startsWith(BUNDLE_HREF.split('?')[0]) ? files : previewData()),
      { headers: { 'content-type': 'application/json' } },
    )));

    new Function(await readFile(bundlePath, 'utf8'))();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(previewHtml()).not.toContain('hero hero--cream');

    // The frame commits: now there is a real document to draw into.
    if (host.contentDocument) host.contentDocument.body.innerHTML = SHELL;
    host.dispatchEvent(new Event('load'));
    for (let attempt = 0; attempt < 400 && !previewHtml().includes('hero'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(previewHtml()).toContain('hero hero--cream');
    expect(previewHtml()).not.toContain('Loading preview');
  });

  it('redraws when the frame is reloaded back to its placeholder', async () => {
    await startPreview();
    expect(previewHtml()).toContain('hero hero--cream');

    // The fallback path reloads the frame; the renderer has to notice and draw
    // again rather than leave the placeholder showing.
    const host = document.querySelector('[data-theme-editor-preview]') as HTMLIFrameElement;
    if (host.contentDocument) host.contentDocument.body.innerHTML = SHELL;
    host.dispatchEvent(new Event('load'));
    for (let attempt = 0; attempt < 400 && !previewHtml().includes('hero'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(previewHtml()).toContain('hero hero--cream');
  });

  it('resolves a binding against the page the preview is showing', async () => {
    const preview = await startPreview() as PreviewApi & { resolve(binding: string): Promise<string> };

    // What the schema panel shows under each setting: the binding put through
    // the same render data the section would receive.
    expect(await preview.resolve('{{ page.blocks[0].title }}')).toBe('Hello from the browser');
    expect(await preview.resolve('{{ page.blocks[0].theme }}')).toBe('cream');

    // A binding edited to a literal resolves to that literal, which is the
    // whole point of the hint following the binding rather than the stored
    // value it started from.
    expect(await preview.resolve('hello')).toBe('hello');
    expect(await preview.resolve('{{ page.blocks[0].primary.label }}')).toBe('Book');
    expect(await preview.resolve('{{ page.blocks[0].nothing }}')).toBe('');
  });

  it('redraws the frame from a visibility toggle without reloading anything', async () => {
    const preview = await startPreview();
    const requestsBefore = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    // What the editor page does with the toggle's response: no navigation, no
    // frame reload, just the new hidden set handed back to the renderer.
    await preview.render({ hidden: ['hero'] });
    expect(previewHtml()).not.toContain('hero hero--cream');
    expect(previewHtml()).toContain('site-footer');

    await preview.render({ hidden: [] });
    expect(previewHtml()).toContain('hero hero--cream');

    const requestsAfter = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(requestsAfter).toBe(requestsBefore);
  });
});
