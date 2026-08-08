import type { PluginEnv } from './types';

/**
 * Selects the registry environment used for tenant authentication.
 *
 * Local Wrangler commands set THEME_EDITOR_AUTH_MODE=env so the credentials
 * in .dev.vars remain authoritative even when a local TENANTS binding has a
 * record left over from an earlier auto-enrollment. Deployed Workers keep the
 * normal KV-backed registry unless they explicitly opt into this mode.
 */
export function tenantAuthEnv(env: PluginEnv): PluginEnv {
  if (env.THEME_EDITOR_AUTH_MODE !== 'env') return env;
  return { ...env, TENANTS: undefined };
}
