import { ADMIN_BASE } from './constants';
import type { PluginEnv } from './types';

export interface ThemeDefinition {
  id: string;
  name: string;
  description: string;
  source: string;
  status: string;
  renderer: 'colorholic';
  assetPrefix: string;
}

export function availableThemes(env: PluginEnv): ThemeDefinition[] {
  return [
    {
      id: 'colorholic-styling',
      name: env.THEME_NAME || 'Colorholic Styling',
      description: 'The development theme synced from the Colorholic Styling Liquid views.',
      source: 'Local views/theme',
      status: 'Development',
      renderer: 'colorholic',
      assetPrefix: '/theme',
    },
  ];
}

export function themeFromId(env: PluginEnv, requestedId: string | null): ThemeDefinition | null {
  const themes = availableThemes(env);
  if (!requestedId) return themes[0] ?? null;
  return themes.find((theme) => theme.id === requestedId) ?? null;
}

export function themeEditorHref(theme: ThemeDefinition, templateId = ''): string {
  const href = `${ADMIN_BASE}/editor?theme=${encodeURIComponent(theme.id)}`;
  return templateId
    ? `${href}&template=${encodeURIComponent(templateId)}`
    : href;
}
