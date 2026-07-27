import type { CmsClientEnv, CmsPage } from '@lionrockjs/worker-cms-plugin';

export interface PluginEnv extends CmsClientEnv {
  TENANTS?: KVNamespace;
  /** Per-template editor overrides; reads degrade to defaults when unbound. */
  THEME_OVERRIDES?: KVNamespace;
  VIEWS: Fetcher;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  THEME_NAME?: string;
  THEME_SITE_TITLE?: string;
  THEME_LANGUAGES?: string;
  THEME_BOOKING_URL?: string;
}

export interface ContentMeta {
  page_types: string[];
  languages: string[];
  default_language: string;
}

export interface ThemeRenderContext {
  page: CmsPage;
  settings: CmsPage | null;
  pages: CmsPage[];
  news: CmsPage[];
  language: string;
  languages: string[];
  defaultLanguage: string;
  editorHref: string;
  selectedBlock: number | null;
}

