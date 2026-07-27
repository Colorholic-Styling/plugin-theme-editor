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
const themePath = resolve(process.cwd(), 'views/theme');

async function themeBundle(): Promise<Record<string, string>> {
  const manifest = JSON.parse(
    await readFile(`${themePath}/theme-manifest.json`, 'utf8'),
  ) as { files: string[] };
  const entries = await Promise.all(manifest.files.map(async (file) =>
    [file, await readFile(`${themePath}${file}`, 'utf8')] as const));
  return Object.fromEntries(entries);
}

function bootstrap(overrides: Record<string, unknown> = {}) {
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
      editorHref: '/admin/plugins/theme-editor/editor?theme=colorholic-styling&template=page&page_id=12',
      selectedBlock: 0,
    },
    template: { id: 'page', label: 'Page', path: '/templates/page.json', format: 'json' },
    hidden: [],
    runtime: { siteTitle: 'Preview site', bookingUrl: 'https://book.example.com', assetVersion: 'dev' },
    bundleHref: '/admin/plugins/theme-editor/preview/bundle?theme=colorholic-styling',
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

async function startPreview(config: Record<string, unknown> = bootstrap()): Promise<PreviewApi> {
  document.body.innerHTML = '';
  const payload = document.createElement('script');
  payload.setAttribute('type', 'application/json');
  payload.setAttribute('data-theme-preview-bootstrap', '');
  payload.textContent = JSON.stringify(config);
  document.body.appendChild(payload);

  const files = await themeBundle();
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(files), {
    headers: { 'content-type': 'application/json' },
  }));

  const source = await readFile(bundlePath, 'utf8');
  new Function(source)();

  const win = window as unknown as { themeEditorPreview?: PreviewApi };
  for (let attempt = 0; attempt < 200 && !win.themeEditorPreview; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!win.themeEditorPreview) throw new Error('Browser preview renderer did not start');
  return win.themeEditorPreview;
}

describe('browser preview renderer', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as { themeEditorPreview?: unknown }).themeEditorPreview;
  });

  it('renders the theme in the browser from the fetched bundle', async () => {
    const preview = await startPreview();
    await preview.render();

    expect(document.body.innerHTML).toContain('hero hero--cream');
    expect(document.body.innerHTML).toContain('Hello from the browser');
    // The selection overlay is part of the shared renderer, so it must survive
    // the trip through the browser build too.
    expect(document.body.innerHTML).toContain('data-theme-editor-block="0"');
    expect(document.body.innerHTML).toContain('theme-editor-block is-selected');
  });

  it('re-renders edited fields without touching the network', async () => {
    const preview = await startPreview();
    await preview.render();
    const requestsBefore = (globalThis.fetch as unknown as { mock?: { calls: unknown[] } }).mock?.calls.length ?? 0;

    const fields = new FormData();
    fields.append('field:/_blocks/0/title/en', 'Typed live');
    await preview.render({ fields });

    expect(document.body.innerHTML).toContain('Typed live');
    expect(document.body.innerHTML).not.toContain('Hello from the browser');
    const requestsAfter = (globalThis.fetch as unknown as { mock?: { calls: unknown[] } }).mock?.calls.length ?? 0;
    expect(requestsAfter).toBe(requestsBefore);
  });

  it('moves the selection overlay without a reload', async () => {
    const preview = await startPreview();
    await preview.render({ selectedBlock: null });
    expect(document.body.innerHTML).not.toContain('theme-editor-block is-selected');

    await preview.render({ selectedBlock: 0 });
    expect(document.body.innerHTML).toContain('theme-editor-block is-selected');
  });

  it('drops a hidden section from the compiled order', async () => {
    const preview = await startPreview();
    await preview.render();
    expect(document.body.innerHTML).toContain('hero hero--cream');

    await preview.render({ hidden: ['hero'] });
    expect(document.body.innerHTML).not.toContain('hero hero--cream');
  });
});
