import { applyEditorFields } from '../editor-model';
import { renderThemePreview, resolveThemeBinding, type ThemeRuntime } from '../theme/renderer';
import type { ThemeStore } from '../theme/store';
import type { ThemeTemplate } from '../theme/templates';
import type { ThemeRenderContext } from '../types';

/**
 * The preview renderer. The Worker serves an empty frame and this draws the
 * page into it: the CMS page arrives as JSON, the theme's template and Liquid
 * partials as a bundle, and every render — first and subsequent — happens here.
 *
 * It imports the Worker's renderer rather than reimplementing it, so the two
 * cannot drift; the only difference is that theme files come from memory
 * instead of an asset binding.
 *
 * This runs in the editor page, not in the frame. The host strips every
 * `<script>` from a plugin HTML document and only lets an approved `<script
 * src>` survive inside a client view, so a renderer shipped in the frame could
 * never execute. The frame is same-origin, so the editor page writes into it.
 */
interface Bootstrap {
  dataHref: string;
  bundleHref: string;
}

interface PreviewData {
  context: ThemeRenderContext;
  template: ThemeTemplate;
  hidden: string[];
  settingOverrides: Record<string, Record<string, string>>;
  structure: { order: string[]; added: Record<string, { type: string }> };
  runtime: Omit<ThemeRuntime, 'store'>;
}

export interface PreviewUpdate {
  lect?: Record<string, unknown>;
  /**
   * The settings form as typed so far. Applied with the same function the save
   * route uses, so an unsaved preview and a saved one cannot disagree about
   * what a field does.
   */
  fields?: FormData;
  selectedBlock?: number | null;
  hidden?: string[];
  /** Per section key, the Liquid its declared settings bind to. */
  settingOverrides?: Record<string, Record<string, string>>;
  /** Pending JSON template structure from sidebar reordering/additions. */
  order?: string[];
  added?: Record<string, { type: string }>;
}

/** Serves the theme from the bundle fetched once at start-up. */
class MemoryThemeStore implements ThemeStore {
  constructor(private readonly files: Record<string, string>) {}

  read(path: string): Promise<string> {
    const source = this.files[normalize(path)];
    return source === undefined
      ? Promise.reject(new Error(`Theme file not found: ${path}`))
      : Promise.resolve(source);
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(normalize(path) in this.files);
  }
}

function normalize(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function frame(): HTMLIFrameElement | null {
  return document.querySelector('[data-theme-editor-preview]');
}

function bootstrap(): Bootstrap | null {
  const host = frame();
  const dataHref = host?.getAttribute('data-theme-editor-preview-data') || '';
  const bundleHref = host?.getAttribute('data-theme-editor-preview-bundle') || '';
  return dataHref && bundleHref ? { dataHref, bundleHref } : null;
}

/**
 * The frame's own document, told apart from the `about:blank` a frame holds
 * until its navigation commits. Readiness cannot be judged by `readyState`,
 * because that blank document already reports `complete`: rendering into it
 * puts the theme somewhere the real document is about to replace, which is why
 * a warm cache — where this script runs before the frame has committed — used
 * to leave the frame showing nothing but its placeholder.
 */
function frameShell(host: HTMLIFrameElement): Document | null {
  const doc = host.contentDocument;
  return doc?.querySelector('[data-theme-preview-status]') ? doc : null;
}

function frameDocument(host: HTMLIFrameElement): Promise<Document> {
  return new Promise((resolve) => {
    const shell = frameShell(host);
    if (shell) {
      resolve(shell);
      return;
    }
    const onLoad = (): void => {
      const loaded = host.contentDocument;
      if (!loaded) return;
      host.removeEventListener('load', onLoad);
      resolve(loaded);
    };
    host.addEventListener('load', onLoad);
  });
}

/**
 * The first render writes the whole document so the theme's own `<head>` is
 * installed; later renders replace the body alone, which keeps the stylesheet
 * from being refetched and the frame's scroll position from jumping.
 */
function apply(doc: Document, html: string, first: boolean): void {
  if (first) {
    doc.open();
    doc.write(html);
    doc.close();
    return;
  }
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  doc.title = parsed.title;
  doc.body.className = parsed.body.className;
  doc.body.innerHTML = parsed.body.innerHTML;
}

function fail(message: string): void {
  const status = frame()?.contentDocument?.querySelector('[data-theme-preview-status]');
  if (status) status.textContent = message;
}

async function json<T>(href: string): Promise<T> {
  const response = await fetch(href, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${href} responded ${response.status}`);
  return await response.json() as T;
}

async function start(): Promise<void> {
  const config = bootstrap();
  const host = frame();
  if (!config || !host) return;

  let data: PreviewData;
  let files: Record<string, string>;
  let doc: Document;
  try {
    [data, files, doc] = await Promise.all([
      json<PreviewData>(config.dataHref),
      json<Record<string, string>>(config.bundleHref),
      frameDocument(host),
    ]);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'The preview could not be loaded.');
    return;
  }

  const runtime: ThemeRuntime = { ...data.runtime, store: new MemoryThemeStore(files) };
  let context = data.context;
  let hidden = new Set(data.hidden);
  let settingOverrides = data.settingOverrides ?? {};
  let structure = data.structure ?? { order: [], added: {} };
  let painted = false;

  const render = async (update: PreviewUpdate = {}): Promise<void> => {
    const base = update.lect ?? context.page.lect ?? {};
    const lect = update.fields ? applyEditorFields(base, update.fields) : base;
    context = {
      ...context,
      page: { ...context.page, lect },
      selectedBlock: update.selectedBlock === undefined ? context.selectedBlock : update.selectedBlock,
    };
    if (update.hidden) hidden = new Set(update.hidden);
    if (update.settingOverrides) settingOverrides = update.settingOverrides;
    if (update.order) structure = { ...structure, order: update.order };
    if (update.added) structure = { ...structure, added: update.added };
    const html = await renderThemePreview(
      runtime, context, data.template, hidden, settingOverrides, structure,
    );

    // Re-read the frame's document rather than trusting the one captured at
    // start-up: a frame that navigated since then has a new document, and the
    // old one is detached, so writing to it would silently do nothing.
    const target = host.contentDocument;
    if (!target) return;
    if (target !== doc) {
      doc = target;
      painted = false;
    }
    apply(doc, html, !painted);
    painted = true;
  };

  // What a template binding resolves to for the page on screen. The editor
  // shows this under each schema setting, so what it reports is whatever the
  // section would actually receive.
  const resolve = (binding: string): Promise<string> =>
    resolveThemeBinding(runtime, context, binding);

  // The parent reads this to decide whether it can re-render in place; without
  // it, every change falls back to reloading the frame.
  (window as unknown as { themeEditorPreview?: unknown }).themeEditorPreview = { render, resolve };

  // A frame showing its placeholder again has been reloaded — by the fallback
  // path, or by a navigation that beat the first render — and needs redrawing.
  // Keyed on the placeholder so the document this writes cannot retrigger it.
  host.addEventListener('load', () => {
    if (frameShell(host)) void render();
  });

  try {
    await render();
  } catch (error) {
    fail(error instanceof Error ? error.message : 'The preview could not be rendered.');
    return;
  }
  // Writing the document replaces what the editor page bound its click and
  // selection handling to, so tell it there is new markup to bind.
  window.postMessage({ type: 'theme-editor-preview-ready' }, window.location.origin);
}

void start();
