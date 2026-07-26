import type { CmsPage } from '@lionrockjs/worker-cms-plugin';
import { ADMIN_BASE } from '../constants';
import type { PluginEnv, ThemeRenderContext } from '../types';
import { mediaUrl, plainText, richText, safeUrl } from './html';
import { attr, indexedBlocks, items, localized, text, truthy, type Lect } from './lect';
import { renderThemeSource } from './liquid';
import { AssetThemeStore } from './store';

const BLOCK_TYPES = [
  'hero', 'rich-text', 'media-text', 'features', 'services', 'steps', 'gallery',
  'testimonials', 'faq', 'stats', 'team', 'logos', 'contact', 'cta', 'news-list',
  'divider',
] as const;

const PREVIEW_TEMPLATE = `
{% layout '/layout/default' %}
{% block content %}
  {% if page.showTitle and page.title != blank %}
  <header class="page-head section section--cream">
    <div class="section__inner">
      <h1 class="page-head__title">{{ page.title | escape }}</h1>
      {% if page.subtitle != blank %}<p class="page-head__subtitle">{{ page.subtitle | escape }}</p>{% endif %}
    </div>
  </header>
  {% endif %}
  {% for section in sections %}
    <div class="theme-editor-block{% if section.editorSelected %} is-selected{% endif %}">
      <a class="theme-editor-select"
         target="_top"
         href="{{ section.editorHref | escape }}"
         aria-label="Edit {{ section.type | escape }} block">
        <span>Edit {{ section.type | escape }}</span>
      </a>
      {% render section.template, block: section %}
    </div>
  {% endfor %}
{% endblock %}`;

const PREVIEW_STYLE = `<style>
.theme-editor-block{position:relative}
.theme-editor-select{position:absolute;inset:0;z-index:1000;display:block;border:2px solid transparent;color:transparent;text-decoration:none}
.theme-editor-select span{position:absolute;top:8px;right:8px;padding:6px 10px;border-radius:999px;background:#4f46e5;color:#fff;font:600 12px/1.2 system-ui;opacity:0;box-shadow:0 2px 8px rgba(0,0,0,.2)}
.theme-editor-block:hover>.theme-editor-select,.theme-editor-select:focus{border-color:#6366f1;outline:0}
.theme-editor-block:hover>.theme-editor-select span,.theme-editor-select:focus span,.theme-editor-block.is-selected>.theme-editor-select span{opacity:1}
.theme-editor-block.is-selected>.theme-editor-select{border-color:#4f46e5;box-shadow:inset 0 0 0 2px rgba(255,255,255,.9)}
</style>`;

export async function renderThemePreview(
  env: PluginEnv,
  context: ThemeRenderContext,
): Promise<string> {
  const chain = languageChain(context.language, context.defaultLanguage, context.languages);
  const labels = strings(context.language);
  const sections = blockViewModels(context.page, chain, context).map((section) => ({
    ...section,
    editorHref: `${context.editorHref}&block=${section.editorIndex}`,
    editorSelected: section.editorIndex === context.selectedBlock,
  }));
  const site = siteModel(env, context.settings, context.pages, chain, labels);
  const pageTitle = localized(context.page.lect, 'title', chain) || context.page.name;
  const html = await renderThemeSource(new AssetThemeStore(env.VIEWS), PREVIEW_TEMPLATE, {
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
    assetVersion: env.CF_VERSION_METADATA?.id?.slice(0, 8) || 'dev',
    meta: {
      title: `${pageTitle} — ${site.brand}`,
      description: plainText(localized(context.page.lect, 'meta_description', chain), 200),
      canonical: '',
      image: mediaUrl(text(context.page.lect, 'picture', chain)),
    },
    page: {
      title: pageTitle,
      subtitle: localized(context.page.lect, 'subtitle', chain),
      showTitle: !indexedBlocks(context.page.lect).some(({ block }) => attr(block, '_type') === 'hero'),
    },
    sections,
  });

  return html
    .replace('</head>', `${PREVIEW_STYLE}</head>`)
    .replaceAll('href="/assets/site.css', `href="${ADMIN_BASE}/theme/assets/site.css`);
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
  env: PluginEnv,
  settings: CmsPage | null,
  pages: CmsPage[],
  chain: string[],
  labels: ReturnType<typeof strings>,
): Record<string, unknown> {
  const lect = settings?.lect ?? {};
  const bookingHref = safeUrl(text(lect, 'booking_url', chain)) || safeUrl(env.THEME_BOOKING_URL || '');
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
    brand: localized(lect, 'brand', chain) || settings?.name || env.THEME_SITE_TITLE || 'Theme preview',
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
