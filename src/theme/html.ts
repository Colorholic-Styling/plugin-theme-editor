const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return value == null ? '' : String(value).replace(/[&<>"']/g, (character) => ENTITIES[character]);
}

export function safeHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<\/?(iframe|object|embed|form|link|meta|base)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi, ' $1="#"');
}

export function richText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/<(p|div|ul|ol|h[1-6]|blockquote|table|br|img|section)\b/i.test(trimmed)) return safeHtml(trimmed);
  return trimmed
    .split(/\r?\n\s*\r?\n/)
    .map((block) => `<p>${block.trim().split(/\r?\n/).map(escapeHtml).join('<br>')}</p>`)
    .join('');
}

export function plainText(value: string, limit = 200): string {
  const stripped = value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > limit ? `${stripped.slice(0, limit - 1).trimEnd()}…` : stripped;
}

export function safeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^(\/|\.\/|#|\?)/.test(trimmed)) return trimmed;
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return '';
  return `https://${trimmed}`;
}

export function mediaUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('/media/') ? trimmed : safeUrl(trimmed);
}

