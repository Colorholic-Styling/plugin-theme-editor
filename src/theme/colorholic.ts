import type { CmsPage } from '@lionrockjs/worker-cms-plugin';
import { ADMIN_BASE } from '../constants';
import type { PluginEnv, ThemeRenderContext } from '../types';
import { mediaUrl, plainText, richText, safeUrl } from './html';
import { attr, indexedBlocks, items, localized, text, truthy, type Lect } from './lect';
import { renderThemeSource } from './liquid';
import { AssetThemeStore, VirtualThemeStore, type ThemeStore } from './store';
import { referencedBlockIndex, type ThemeTemplate } from './templates';

const BLOCK_TYPES = [
  'hero', 'rich-text', 'media-text', 'features', 'services', 'steps', 'gallery',
  'testimonials', 'faq', 'stats', 'team', 'logos', 'contact', 'cta', 'news-list',
  'divider',
] as const;

/**
 * Selection overlays live on each block's own template rather than around a
 * loop the plugin controls. A JSON template may delegate the block loop to a
 * theme section — `{ "type": "content" }` rendering `{% render item.template %}`
 * — in which case the plugin never sees the iteration, so wrapping there would
 * silently drop every overlay.
 */
const EDITOR_BLOCK_TEMPLATE = '/theme-editor/block';

const EDITOR_BLOCK_SOURCE = overlayWrapped(
  'section',
  '{% render section.editorTemplate, block: section, section: section %}',
  false,
);

/**
 * Selection overlay around whatever renders one CMS block. `guarded` covers the
 * case where the bound block may not exist on the page, which a JSON template
 * cannot know when it names a fixed block index.
 */
function overlayWrapped(variable: string, inner: string, guarded: boolean): string {
  const open = `<div class="theme-editor-block{% if ${variable}.editorSelected %} is-selected{% endif %}"
     data-theme-editor-block="{{ ${variable}.editorIndex }}">
  <a class="theme-editor-select"
     target="_top"
     href="{{ ${variable}.editorHref | escape }}"
     aria-label="Edit {{ ${variable}.type | escape }} block">
    <span>Edit {{ ${variable}.type | escape }}</span>
  </a>`;
  return guarded
    ? `{% if ${variable} %}${open}{% endif %}\n${inner}\n{% if ${variable} %}</div>{% endif %}`
    : `${open}\n${inner}\n</div>`;
}

/** Block loop for templates that leave block rendering to the plugin. */
const CMS_SECTIONS_SOURCE = `
{% for cmsBlock in blocks %}
    {% render cmsBlock.template, block: cmsBlock, section: cmsBlock %}
{% endfor %}`;

const PREVIEW_STYLE = `<style>
.theme-editor-block{position:relative}
.theme-editor-select{position:absolute;inset:0;z-index:1000;display:block;border:2px solid transparent;color:transparent;text-decoration:none}
.theme-editor-select span{position:absolute;top:8px;right:8px;padding:6px 10px;border-radius:999px;background:#4f46e5;color:#fff;font:600 12px/1.2 system-ui;opacity:0;box-shadow:0 2px 8px rgba(0,0,0,.2)}
.theme-editor-block:hover>.theme-editor-select,.theme-editor-select:focus{border-color:#6366f1;outline:0}
.theme-editor-block:hover>.theme-editor-select span,.theme-editor-select:focus span,.theme-editor-block.is-selected>.theme-editor-select span{opacity:1}
.theme-editor-block.is-selected>.theme-editor-select{border-color:#4f46e5;box-shadow:inset 0 0 0 2px rgba(255,255,255,.9)}
</style>`;

/**
 * Everything the renderer needs from its host. Keeping this to plain values and
 * a `ThemeStore` is what lets the identical projection run on the Worker and in
 * the browser: a preview that re-implemented any of this would be free to drift
 * from what the Worker renders, which is the one thing a preview must not do.
 */
export interface ThemeRuntime {
  store: ThemeStore;
  siteTitle: string;
  bookingUrl: string;
  assetVersion: string;
}

export function themeRuntime(env: PluginEnv, store: ThemeStore): ThemeRuntime {
  return {
    store,
    siteTitle: env.THEME_SITE_TITLE || '',
    bookingUrl: env.THEME_BOOKING_URL || '',
    assetVersion: env.CF_VERSION_METADATA?.id?.slice(0, 8) || 'dev',
  };
}

export function previewThemeStore(base: ThemeStore): ThemeStore {
  return new VirtualThemeStore(base, {
    [`${EDITOR_BLOCK_TEMPLATE}.liquid`]: EDITOR_BLOCK_SOURCE,
  });
}

export async function renderThemePreview(
  runtime: ThemeRuntime,
  context: ThemeRenderContext,
  template: ThemeTemplate,
  hidden: ReadonlySet<string> = new Set(),
): Promise<string> {
  const chain = languageChain(context.language, context.defaultLanguage, context.languages);
  const labels = strings(context.language);
  const sections = blockViewModels(context.page, chain, context).map((section) => ({
    ...section,
    settings: section,
    editorTemplate: section.template,
    template: EDITOR_BLOCK_TEMPLATE,
    editorHref: `${context.editorHref}&block=${section.editorIndex}`,
    editorSelected: section.editorIndex === context.selectedBlock,
  }));
  const site = siteModel(runtime, context.settings, context.pages, chain, labels);
  const pageTitle = localized(context.page.lect, 'title', chain) || context.page.name;
  const pageSubtitle = localized(context.page.lect, 'subtitle', chain);
  const articles = context.news.map((articlePage) => newsArticleModel(articlePage, chain));
  const article = newsArticleModel(context.page, chain);
  const store = runtime.store;
  const renderData: Record<string, unknown> = {
    lang: context.language === 'mis' ? context.defaultLanguage : context.language,
    language: context.language,
    prefix: '',
    site,
    t: labels,
    languages: context.languages.map((code) => ({
      code,
      label: languageLabel(code),
      href: '#',
      active: code === context.language,
    })),
    canonicalOrigin: '',
    assetVersion: runtime.assetVersion,
    meta: {
      title: `${pageTitle} — ${site.brand}`,
      description: plainText(localized(context.page.lect, 'meta_description', chain), 200),
      canonical: '',
      image: mediaUrl(text(context.page.lect, 'picture', chain)),
    },
    page: {
      title: pageTitle,
      subtitle: pageSubtitle,
      showTitle: !indexedBlocks(context.page.lect).some(({ block }) => attr(block, '_type') === 'hero'),
      blocks: sections,
    },
    heading: pageTitle,
    intro: pageSubtitle || labels.newsIntro,
    articles,
    hasArticles: articles.length > 0,
    article,
    code: attr(context.page.lect, 'code') || String(context.page.id),
    message: localized(context.page.lect, 'message', chain)
      || localized(context.page.lect, 'body', chain),
    blocks: sections,
    sections,
  };
  const compiledTemplate = await previewTemplateSource(store, template, renderData, hidden);
  renderData.templateSections = compiledTemplate.sections;
  const html = await renderThemeSource(store, compiledTemplate.source, renderData);

  return html
    .replace('</head>', `${PREVIEW_STYLE}</head>`)
    .replaceAll('href="/assets/site.css', `href="${ADMIN_BASE}/theme/assets/site.css`);
}

async function previewTemplateSource(
  store: ThemeStore,
  template: ThemeTemplate,
  data: Record<string, unknown>,
  hidden: ReadonlySet<string>,
): Promise<{ source: string; sections: Record<string, unknown> }> {
  const source = await store.read(template.path);
  if (template.format === 'liquid') return { source, sections: {} };

  const definition = JSON.parse(source) as unknown;
  if (!isRecord(definition)) throw new Error(`Invalid theme template: ${template.id}`);
  const layout = safeTemplateToken(definition.layout) || 'default';
  const sections = isRecord(definition.sections) ? definition.sections : {};
  // Hiding a section drops it from the order the preview compiles, leaving the
  // theme's own template file untouched.
  const order = Array.isArray(definition.order)
    ? definition.order.filter((key): key is string => typeof key === 'string' && !hidden.has(key))
    : [];
  const templateSections: Record<string, unknown> = {};
  const renderedSections: string[] = [];
  for (const [index, key] of order.entries()) {
    const section = sections[key];
    if (!isRecord(section)) continue;
    if (section.source !== undefined) {
      if (section.source !== 'blocks') {
        throw new Error(`Invalid theme template ${template.id}: unsupported source "${String(section.source)}"`);
      }
      renderedSections.push(CMS_SECTIONS_SOURCE);
      continue;
    }
    const type = safeTemplateToken(section.type);
    if (!type) continue;
    if (type === 'cms-sections') {
      renderedSections.push(CMS_SECTIONS_SOURCE);
      continue;
    }
    const variable = `s${index}`;
    templateSections[variable] = {
      id: key,
      type,
      settings: await resolveTemplateValue(store, section.settings ?? {}, data),
      blocks: await resolveTemplateBlocks(store, section, data),
    };
    const renderCall = `{% render '/sections/${type}', section: templateSections.${variable} %}`;
    const boundBlock = referencedBlockIndex(section);
    renderedSections.push(boundBlock === null
      ? renderCall
      : `{% assign cmsBlock = page.blocks[${boundBlock}] %}\n${overlayWrapped('cmsBlock', renderCall, true)}`);
  }
  const wrapper = wrapperTags(definition.wrapper);

  return {
    source: `
{% layout '/layout/${layout}' %}
{% block content %}
${wrapper.open}
${renderedSections.join('\n')}
${wrapper.close}
{% endblock %}`,
    sections: templateSections,
  };
}

async function resolveTemplateBlocks(
  store: ThemeStore,
  section: Record<string, unknown>,
  data: Record<string, unknown>,
): Promise<unknown[]> {
  if (!isRecord(section.blocks)) return [];
  const requestedOrder = Array.isArray(section.block_order)
    ? section.block_order.filter((id): id is string => typeof id === 'string')
    : Object.keys(section.blocks);
  const blocks: unknown[] = [];
  for (const id of requestedOrder) {
    const block = section.blocks[id];
    if (!isRecord(block)) continue;
    blocks.push({
      id,
      type: safeTemplateToken(block.type),
      settings: await resolveTemplateValue(store, block.settings ?? {}, data),
    });
  }
  return blocks;
}

async function resolveTemplateValue(
  store: ThemeStore,
  value: unknown,
  data: Record<string, unknown>,
): Promise<unknown> {
  if (typeof value === 'string') {
    return value.includes('{{') || value.includes('{%')
      ? renderThemeSource(store, value, data)
      : value;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolveTemplateValue(store, item, data)));
  }
  if (!isRecord(value)) return value;

  const resolved = await Promise.all(Object.entries(value).map(async ([key, item]) => [
    key,
    await resolveTemplateValue(store, item, data),
  ] as const));
  return Object.fromEntries(resolved);
}

function wrapperTags(value: unknown): { open: string; close: string } {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*)*$/i.test(value)) {
    return { open: '', close: '' };
  }
  const [tag, ...classes] = value.split('.');
  return {
    open: `<${tag}${classes.length ? ` class="${classes.join(' ')}"` : ''}>`,
    close: `</${tag}>`,
  };
}

function safeTemplateToken(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value)
    ? value
    : '';
}

function newsArticleModel(page: CmsPage, chain: string[]): Record<string, unknown> {
  return {
    title: localized(page.lect, 'title', chain) || page.name,
    href: '#',
    summary: localized(page.lect, 'summary', chain),
    picture: mediaUrl(text(page.lect, 'picture', chain)),
    bodyHtml: richText(localized(page.lect, 'body', chain)),
    dateText: page.start?.slice(0, 10) || page.created_at.slice(0, 10),
    dateIso: page.start || page.created_at,
  };
}

function blockViewModels(
  page: CmsPage,
  chain: string[],
  renderContext: ThemeRenderContext,
): Array<Record<string, unknown> & { editorIndex: number }> {
  const models: Array<Record<string, unknown> & { editorIndex: number }> = [];
  for (const { block, index } of indexedBlocks(page.lect)) {
    const model = blockViewModel(block, index, chain, renderContext);
    if (model) models.push({ ...model, template: `/sections/${String(model.type)}`, editorIndex: index });
  }
  return models;
}

function blockViewModel(
  block: Lect,
  index: number,
  chain: string[],
  context: ThemeRenderContext,
): Record<string, unknown> | null {
  const type = attr(block, '_type');
  if (!(BLOCK_TYPES as readonly string[]).includes(type)) return null;

  const common = {
    type,
    key: attr(block, '_id') || `b${index}`,
    anchor: slugToken(attr(block, 'anchor')),
    theme: themeToken(attr(block, 'theme')),
    align: alignToken(attr(block, 'align')),
    eyebrow: localized(block, 'eyebrow', chain),
    title: localized(block, 'title', chain),
    bodyHtml: richText(localized(block, 'body', chain)),
    hasHeader: false,
  };
  common.hasHeader = Boolean(common.eyebrow || common.title || common.bodyHtml);
  const bookingUrl = safeUrl(context.settings ? text(context.settings.lect, 'booking_url', chain) : '');

  switch (type) {
    case 'hero':
      return {
        ...common,
        picture: mediaUrl(text(block, 'picture', chain)),
        pictureAlt: localized(block, 'picture_alt', chain) || common.title,
        primary: button(block, 'primary', chain, bookingUrl),
        secondary: button(block, 'secondary', chain, bookingUrl),
      };
    case 'rich-text':
      return common;
    case 'media-text':
      return {
        ...common,
        picture: mediaUrl(text(block, 'picture', chain)),
        pictureAlt: localized(block, 'picture_alt', chain) || common.title,
        caption: localized(block, 'caption', chain),
        mediaFirst: attr(block, 'media_position').trim().toLowerCase() !== 'right',
        link: button(block, 'link', chain, bookingUrl),
      };
    case 'features':
      return {
        ...common,
        columns: columnToken(attr(block, 'columns'), 3),
        features: items(block, 'features').map((row) => ({
          icon: localized(row, 'icon', chain),
          name: localized(row, 'name', chain),
          description: localized(row, 'description', chain),
        })).filter((row) => row.name || row.description),
      };
    case 'services':
      return {
        ...common,
        note: localized(block, 'note', chain),
        services: items(block, 'services').map((row) => ({
          name: localized(row, 'name', chain),
          description: localized(row, 'description', chain),
          duration: localized(row, 'duration', chain),
          price: localized(row, 'price', chain),
          href: safeUrl(text(row, 'url', chain)) || bookingUrl,
          label: localized(row, 'label', chain),
        })).filter((row) => row.name),
      };
    case 'steps':
      return {
        ...common,
        steps: items(block, 'steps').map((row, position) => ({
          index: position + 1,
          name: localized(row, 'name', chain),
          description: localized(row, 'description', chain),
        })).filter((row) => row.name || row.description),
      };
    case 'gallery':
      return {
        ...common,
        columns: columnToken(attr(block, 'columns'), 3),
        pictures: items(block, 'pictures').map((row) => ({
          src: mediaUrl(text(row, 'picture', chain)),
          caption: localized(row, 'caption', chain),
        })).filter((row) => row.src),
      };
    case 'testimonials':
      return {
        ...common,
        testimonials: items(block, 'testimonials').map((row) => ({
          quote: localized(row, 'quote', chain),
          name: localized(row, 'name', chain),
          role: localized(row, 'role', chain),
          picture: mediaUrl(text(row, 'picture', chain)),
          stars: starList(attr(row, 'rating')),
        })).filter((row) => row.quote),
      };
    case 'stats':
      return {
        ...common,
        stats: items(block, 'stats').map((row) => ({
          value: localized(row, 'value', chain),
          label: localized(row, 'label', chain),
        })).filter((row) => row.value),
      };
    case 'faq':
      return {
        ...common,
        faqs: items(block, 'faqs').map((row) => ({
          question: localized(row, 'question', chain),
          answerHtml: richText(localized(row, 'answer', chain)),
        })).filter((row) => row.question),
      };
    case 'team':
      return {
        ...common,
        members: items(block, 'members').map((row) => ({
          name: localized(row, 'name', chain),
          role: localized(row, 'role', chain),
          bio: localized(row, 'bio', chain),
          picture: mediaUrl(text(row, 'picture', chain)),
        })).filter((row) => row.name),
      };
    case 'logos':
      return {
        ...common,
        logos: items(block, 'logos').map((row) => ({
          src: mediaUrl(text(row, 'picture', chain)),
          name: localized(row, 'name', chain),
          href: safeUrl(text(row, 'url', chain)),
        })).filter((row) => row.src),
      };
    case 'contact': {
      const phone = localized(block, 'phone', chain) || attr(block, 'phone');
      const email = localized(block, 'email', chain) || attr(block, 'email');
      const whatsapp = attr(block, 'whatsapp').replace(/[^\d+]/g, '');
      return {
        ...common,
        addressLines: lines(localized(block, 'address', chain)),
        hoursLines: lines(localized(block, 'hours', chain)),
        phone,
        phoneHref: phone ? `tel:${phone.replace(/[^\d+]/g, '')}` : '',
        email,
        emailHref: email ? `mailto:${email}` : '',
        whatsappHref: whatsapp ? `https://wa.me/${whatsapp.replace(/^\+/, '')}` : '',
        map: button(block, 'map', chain, bookingUrl),
        booking: button(block, 'booking', chain, bookingUrl),
      };
    }
    case 'cta':
      return {
        ...common,
        picture: mediaUrl(text(block, 'picture', chain)),
        button: button(block, 'button', chain, bookingUrl),
      };
    case 'news-list': {
      const limit = Math.max(1, Number.parseInt(attr(block, 'limit'), 10) || 3);
      const news = context.news.slice(0, limit).map((page) => ({
        title: localized(page.lect, 'title', chain) || page.name,
        href: '#',
        summary: localized(page.lect, 'summary', chain),
        picture: mediaUrl(text(page.lect, 'picture', chain)),
        dateText: page.start?.slice(0, 10) || page.created_at.slice(0, 10),
        dateIso: page.start || page.created_at,
      }));
      return {
        ...common,
        news,
        hasNews: news.length > 0,
        indexHref: '#',
        indexLabel: localized(block, 'link', chain) || localized(block, 'link_label', chain),
      };
    }
    case 'divider':
      return {
        type,
        key: common.key,
        theme: common.theme,
        spacing: ['sm', 'md', 'lg'].includes(attr(block, 'spacing')) ? attr(block, 'spacing') : 'md',
        rule: truthy(attr(block, 'rule')),
      };
    default:
      return null;
  }
}

function siteModel(
  runtime: ThemeRuntime,
  settings: CmsPage | null,
  pages: CmsPage[],
  chain: string[],
  labels: ReturnType<typeof strings>,
): Record<string, unknown> {
  const lect = settings?.lect ?? {};
  const bookingHref = safeUrl(text(lect, 'booking_url', chain)) || safeUrl(runtime.bookingUrl);
  const configuredNav = items(lect, 'nav').map((row) => ({
    label: localized(row, 'label', chain),
    href: safeUrl(text(row, 'url', chain)) || '#',
    active: false,
    external: false,
  })).filter((item) => item.label);
  const nav = configuredNav.length ? configuredNav : pages.map((page) => ({
    label: localized(page.lect, 'title', chain) || page.name,
    href: '#',
    active: true,
    external: false,
  }));
  const phone = text(lect, 'phone', chain);
  const email = text(lect, 'email', chain);
  return {
    brand: localized(lect, 'brand', chain) || settings?.name || runtime.siteTitle || 'Theme preview',
    tagline: localized(lect, 'tagline', chain),
    logo: mediaUrl(text(lect, 'logo', chain)),
    description: plainText(localized(lect, 'description', chain), 200),
    nav,
    footerLinks: linkItems(items(lect, 'footer_links'), chain),
    social: linkItems(items(lect, 'social'), chain).map((item) => ({ name: item.label, href: item.href })),
    footerNoteHtml: richText(localized(lect, 'footer_note', chain)),
    address: lines(localized(lect, 'address', chain)),
    hours: lines(localized(lect, 'hours', chain)),
    phone,
    phoneHref: phone ? `tel:${phone.replace(/[^\d+]/g, '')}` : '',
    email,
    emailHref: email ? `mailto:${email}` : '',
    booking: {
      label: localized(lect, 'booking_label', chain) || labels.book,
      href: bookingHref,
      has: Boolean(bookingHref),
    },
    homeHref: '#',
    newsHref: '#',
    year: new Date().getFullYear(),
  };
}

function linkItems(rows: Lect[], chain: string[]): Array<{ label: string; href: string; active: boolean; external: boolean }> {
  return rows.map((row) => {
    const href = safeUrl(text(row, 'url', chain));
    return {
      label: localized(row, 'label', chain) || localized(row, 'name', chain),
      href,
      active: false,
      external: /^(https?:)?\/\//.test(href),
    };
  }).filter((item) => item.label && item.href);
}

function button(block: Lect, name: string, chain: string[], fallback: string) {
  const grouped = block[name];
  const source = grouped && typeof grouped === 'object' && !Array.isArray(grouped) ? grouped as Lect : block;
  const label = localized(source, 'label', chain) || localized(block, `${name}_label`, chain);
  const href = safeUrl(text(source, 'url', chain) || text(block, `${name}_url`, chain)) || (label ? fallback : '');
  return { label, href, has: Boolean(label && href) };
}

function languageChain(language: string, defaultLanguage: string, languages: string[]): string[] {
  return [...new Set([language, defaultLanguage, ...languages, 'mis', 'en'].filter(Boolean))];
}

function languageLabel(code: string): string {
  return ({ 'zh-hant': '繁體中文', 'zh-hans': '简体中文', en: 'English', mis: '—' } as Record<string, string>)[code]
    || code;
}

function strings(language: string) {
  const english = {
    news: 'News',
    newsIntro: 'Latest updates.',
    newsEmpty: 'No updates have been published yet.',
    readMore: 'Read more',
    book: 'Book now',
    backHome: 'Back to home',
    backToNews: 'All news',
    skipToContent: 'Skip to content',
    menu: 'Menu',
    published: 'Published',
    hours: 'Opening hours',
    address: 'Address',
    contact: 'Contact',
    from: 'from',
  };
  if (!language.startsWith('zh')) return english;
  return {
    ...english,
    news: '最新消息',
    readMore: '閱讀更多',
    book: '立即預約',
    backToNews: '所有消息',
    skipToContent: '跳至主要內容',
    menu: '選單',
    hours: '營業時間',
    address: '地址',
    contact: '聯絡我們',
  };
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function starList(value: string): number[] {
  return Array.from({ length: Math.min(5, Math.max(0, Math.round(Number(value) || 0))) }, (_, index) => index + 1);
}

function themeToken(value: string): string {
  const normalized = value.trim().toLowerCase();
  return ['light', 'cream', 'dark', 'accent'].includes(normalized) ? normalized : 'light';
}

function alignToken(value: string): string {
  return value.trim().toLowerCase() === 'center' ? 'center' : 'left';
}

function columnToken(value: string, fallback: number): number {
  const columns = Number.parseInt(value, 10);
  return columns >= 2 && columns <= 4 ? columns : fallback;
}

function slugToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
