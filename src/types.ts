import type { CmsClientEnv, CmsPage } from '@lionrockjs/worker-cms-plugin';

export interface PluginEnv extends CmsClientEnv {
  TENANTS?: KVNamespace;
  /** Optional comma-separated allowlist for automatic tenant enrollment. */
  TENANT_ENROLL_ORIGINS?: string;
  /** Per-template editor overrides; reads degrade to defaults when unbound. */
  THEME_OVERRIDES?: KVNamespace;
  /** Theme library root: one folder per theme, writable by this Worker. */
  THEMES?: R2Bucket;
  /** Fine-grained GitHub token (Contents: read and write) for theme sync. */
  GITHUB_TOKEN?: string;
  /** GitHub App installation metadata, keyed by the CMS tenant ref. */
  GITHUB_CONNECTIONS?: KVNamespace;
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  /** PKCS#1 or PKCS#8 PEM private key generated for the GitHub App. */
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  /** HMAC secret for the short-lived tenant state sent through GitHub. */
  GITHUB_APP_STATE_SECRET?: string;
  /** Added by tenantClientEnv after an authenticated host request. */
  CMS_TENANT_ID?: string;
  CMS_TENANT_REF?: string;
  VIEWS: Fetcher;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  THEME_ID?: string;
  THEME_NAME?: string;
  THEME_SITE_TITLE?: string;
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
