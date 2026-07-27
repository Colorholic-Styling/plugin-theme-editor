import { applyEditorFields } from '../editor-model';
import { renderThemePreview, type ThemeRuntime } from '../theme/colorholic';
import type { ThemeStore } from '../theme/store';
import type { ThemeTemplate } from '../theme/templates';
import type { ThemeRenderContext } from '../types';

/**
 * Browser half of the preview. It imports the Worker's renderer rather than
 * reimplementing it, so the two cannot drift: the only things that differ are
 * where theme files come from and where the HTML is put.
 *
 * The server still renders the first paint, which keeps the preview correct
 * when this asset is unapproved or still loading. Once it is running, editing a
 * block re-renders here and reaches no network at all.
 */
interface Bootstrap {
  context: ThemeRenderContext;
  template: ThemeTemplate;
  hidden: string[];
  runtime: Omit<ThemeRuntime, 'store'>;
  bundleHref: string;
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

function bootstrap(): Bootstrap | null {
  const source = document.querySelector('[data-theme-preview-bootstrap]');
  if (!source) return null;
  try {
    return JSON.parse(source.textContent || '') as Bootstrap;
  } catch {
    return null;
  }
}

/**
 * Only the document's body and title are replaced. Swapping the whole document
 * would discard this script along with the head's stylesheet, costing a
 * re-fetch of exactly what a local re-render exists to avoid.
 */
function apply(html: string): void {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.title = parsed.title;
  document.body.className = parsed.body.className;
  document.body.innerHTML = parsed.body.innerHTML;
}

async function start(): Promise<void> {
  const config = bootstrap();
  if (!config) return;

  const response = await fetch(config.bundleHref, { headers: { accept: 'application/json' } });
  if (!response.ok) return;
  const runtime: ThemeRuntime = {
    ...config.runtime,
    store: new MemoryThemeStore(await response.json() as Record<string, string>),
  };

  let context = config.context;
  let hidden = new Set(config.hidden);

  const render = async (update: PreviewUpdate = {}): Promise<void> => {
    const base = update.lect ?? context.page.lect ?? {};
    const lect = update.fields ? applyEditorFields(base, update.fields) : base;
    context = {
      ...context,
      page: { ...context.page, lect },
      selectedBlock: update.selectedBlock === undefined ? context.selectedBlock : update.selectedBlock,
    };
    if (update.hidden) hidden = new Set(update.hidden);
    apply(await renderThemePreview(runtime, context, config.template, hidden));
  };

  // The parent reads this to decide whether it can re-render in place; without
  // it, every change falls back to reloading the frame from the Worker.
  (window as unknown as { themeEditorPreview?: unknown }).themeEditorPreview = { render };
  window.parent.postMessage({ type: 'theme-editor-preview-ready' }, window.location.origin);
}

void start();
