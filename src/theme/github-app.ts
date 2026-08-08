import {
  pluginState,
  tenantById,
  tenantClientEnv,
  type Tenant,
} from '@lionrockjs/worker-cms-plugin';
import { ADMIN_BASE, PLUGIN_ID } from '../constants';
import { tenantAuthEnv } from '../tenant-auth';
import type { PluginEnv } from '../types';
import { GitHubError } from './github';

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const CALLBACK_PATH = '/__plugin/github/callback';
const STATE_LIFETIME_SECONDS = 10 * 60;
/**
 * Where the connected installation lives on the CMS that owns it. It is the
 * host's record, not this Worker's: one plugin Worker serves many CMS hosts,
 * so a copy kept here would outlive the host, stay invisible to its admins,
 * and be readable by whoever operates the plugin.
 */
const CONNECTION_STATE_KEY = 'github.connection';
/** Pre-migration KV key prefix, still read once per tenant. See getGitHubConnection. */
const CONNECTION_KEY_PREFIX = 'github:';

interface GitHubAppConfig {
  appId: string;
  slug: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  stateSecret: string;
}

interface GitHubState {
  v: 1;
  tenantId: string;
  userId: string;
  iat: number;
  exp: number;
  nonce: string;
}

interface GitHubInstallation {
  id: number;
  app_id?: number;
  account?: {
    login?: string;
    type?: string;
  };
  permissions?: {
    contents?: string;
  };
  repository_selection?: string;
  html_url?: string;
}

export interface GitHubConnection {
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: 'all' | 'selected';
  manageUrl: string;
  connectedAt: string;
}

export interface GitHubRepository {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
}

export interface GitHubAppDashboard {
  configured: boolean;
  configurationMessage: string;
  connected: boolean;
  connection: GitHubConnection | null;
  repositories: GitHubRepository[];
  error: string;
}

export interface GitHubAccess {
  token: string;
  source: 'app' | 'personal-token';
}

/**
 * The installation flow is available only when every credential is present. A
 * partially configured App is reported rather than silently presenting a
 * Connect button that cannot finish its callback.
 *
 * Only credentials are listed: the connection itself is stored on the CMS
 * (see CONNECTION_STATE_KEY), which every authenticated request already has.
 */
export function githubAppConfiguration(env: PluginEnv): {
  config: GitHubAppConfig | null;
  message: string;
} {
  const values = {
    appId: env.GITHUB_APP_ID?.trim() ?? '',
    slug: env.GITHUB_APP_SLUG?.trim() ?? '',
    privateKey: env.GITHUB_APP_PRIVATE_KEY?.trim() ?? '',
    clientId: env.GITHUB_APP_CLIENT_ID?.trim() ?? '',
    clientSecret: env.GITHUB_APP_CLIENT_SECRET?.trim() ?? '',
    stateSecret: env.GITHUB_APP_STATE_SECRET?.trim() ?? '',
  };
  const missing = [
    !values.appId && 'GITHUB_APP_ID',
    !values.slug && 'GITHUB_APP_SLUG',
    !values.privateKey && 'GITHUB_APP_PRIVATE_KEY',
    !values.clientId && 'GITHUB_APP_CLIENT_ID',
    !values.clientSecret && 'GITHUB_APP_CLIENT_SECRET',
    values.stateSecret.length < 32 && 'GITHUB_APP_STATE_SECRET (at least 32 characters)',
  ].filter((value): value is string => Boolean(value));
  const attempted = Object.values(values).some(Boolean);

  if (missing.length) {
    return {
      config: null,
      message: attempted
        ? `GitHub App setup is incomplete. Missing: ${missing.join(', ')}.`
        : '',
    };
  }
  return { config: values, message: '' };
}

/** Starts GitHub's install + OAuth-on-install flow for an authenticated tenant. */
export async function githubInstallUrl(env: PluginEnv, userId: string): Promise<string> {
  const { config, message } = githubAppConfiguration(env);
  if (!config) throw new GitHubError(message || 'The GitHub App is not configured.');
  if (!env.CMS_TENANT_ID) throw new GitHubError('The CMS tenant could not be identified.');

  const now = Math.floor(Date.now() / 1000);
  const state = await signState({
    v: 1,
    tenantId: env.CMS_TENANT_ID,
    userId,
    iat: now,
    exp: now + STATE_LIFETIME_SECONDS,
    nonce: randomBase64Url(18),
  }, config.stateSecret);
  return `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new`
    + `?state=${encodeURIComponent(state)}`;
}

/**
 * GitHub calls this endpoint directly rather than through the CMS admin proxy.
 * The signed state proves that an authenticated theme editor initiated the
 * flow; the short-lived GitHub user token then proves that the installer may
 * access the installation id returned by GitHub.
 */
export async function handleGitHubAppCallback(
  request: Request,
  baseEnv: PluginEnv,
): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response('GET required.', { status: 405, headers: noStoreHeaders() });
  }
  const url = new URL(request.url);
  const { config, message } = githubAppConfiguration(baseEnv);
  if (!config) return callbackError(message || 'The GitHub App is not configured.', 503);

  const state = await verifyState(url.searchParams.get('state') ?? '', config.stateSecret);
  if (!state) return callbackError('The GitHub connection request is invalid or has expired.', 400);

  const tenant = await tenantById(tenantAuthEnv(baseEnv), state.tenantId);
  if (!tenant) return callbackError('The CMS tenant is no longer connected.', 403);
  const env = tenantClientEnv(baseEnv, tenant) as PluginEnv;

  const githubFailure = url.searchParams.get('error_description') || url.searchParams.get('error');
  if (githubFailure) return redirectToTenant(tenant, `GitHub connection was not completed: ${githubFailure}`);

  const code = url.searchParams.get('code')?.trim() ?? '';
  const installationId = positiveInt(url.searchParams.get('installation_id'));
  if (!code || !installationId) {
    return redirectToTenant(tenant, 'GitHub did not return a usable installation.');
  }

  try {
    const userToken = await exchangeUserCode(config, code);
    const installations = await userInstallations(userToken);
    const installation = installations.find((entry) => entry.id === installationId);
    if (!installation) {
      throw new GitHubError(
        'The GitHub user who completed the connection cannot access that App installation.',
        403,
      );
    }
    if (installation.permissions?.contents !== 'write') {
      throw new GitHubError(
        'The GitHub App installation needs Contents: read and write permission.',
        403,
      );
    }
    if (installation.app_id !== undefined && String(installation.app_id) !== config.appId) {
      throw new GitHubError('The returned installation belongs to a different GitHub App.', 403);
    }

    // The connection is recorded on the CMS, so this last step can fail after
    // GitHub has already installed the App. Say so plainly: retrying Connect is
    // safe, because the installation id is re-derived from GitHub rather than
    // taken from the callback URL, so a second run records the same thing.
    try {
      await putGitHubConnection(env, {
        installationId,
        accountLogin: installation.account?.login?.trim() || 'GitHub account',
        accountType: installation.account?.type?.trim() || 'Account',
        repositorySelection: installation.repository_selection === 'all' ? 'all' : 'selected',
        manageUrl: safeGitHubUrl(installation.html_url),
        connectedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Could not record the GitHub connection on the CMS:', error);
      throw new GitHubError(
        'The GitHub App was installed, but this CMS could not record the connection. '
        + 'Try Connect again — the installation is reused, not duplicated.',
      );
    }
    return redirectToTenant(
      tenant,
      `Connected GitHub as ${installation.account?.login?.trim() || 'the selected account'}.`,
    );
  } catch (error) {
    return redirectToTenant(tenant, githubAppMessage(error));
  }
}

export async function githubAppDashboard(env: PluginEnv): Promise<GitHubAppDashboard> {
  const { config, message } = githubAppConfiguration(env);
  if (!config) {
    return {
      configured: false,
      configurationMessage: message,
      connected: false,
      connection: null,
      repositories: [],
      error: '',
    };
  }

  const connection = await getGitHubConnection(env);
  if (!connection) {
    return {
      configured: true,
      configurationMessage: '',
      connected: false,
      connection: null,
      repositories: [],
      error: '',
    };
  }

  try {
    return {
      configured: true,
      configurationMessage: '',
      connected: true,
      connection,
      repositories: await installationRepositories(config, connection.installationId),
      error: '',
    };
  } catch (error) {
    return {
      configured: true,
      configurationMessage: '',
      connected: true,
      connection,
      repositories: [],
      error: githubAppMessage(error),
    };
  }
}

/**
 * Resolves the tenant's App installation first, then the legacy PAT fallback.
 *
 * Credentials are checked before the connection is looked up: without them no
 * installation token can be minted whatever the host has stored, so asking is
 * pointless — and this keeps a PAT-only install from depending on the CMS
 * being reachable just to read "nothing is connected".
 */
export async function githubAccess(env: PluginEnv): Promise<GitHubAccess | null> {
  const { config } = githubAppConfiguration(env);
  const connection = config ? await getGitHubConnection(env) : null;
  if (config && connection) {
    return {
      token: await installationToken(config, connection.installationId),
      source: 'app',
    };
  }
  const token = env.GITHUB_TOKEN?.trim();
  return token ? { token, source: 'personal-token' } : null;
}

export async function disconnectGitHubApp(env: PluginEnv): Promise<void> {
  await pluginState(env, PLUGIN_ID).delete(CONNECTION_STATE_KEY);
  // Also clear any pre-migration copy, so disconnecting cannot be undone by the
  // legacy read below resurrecting the old record on the next request.
  const key = legacyConnectionKey(env);
  if (env.GITHUB_CONNECTIONS && key) await env.GITHUB_CONNECTIONS.delete(key);
}

/**
 * The connected installation, from the host that owns it.
 *
 * Installs made before this moved host-side still have their record in the
 * plugin's own KV; those are read once and written through to the host, so the
 * old namespace drains as tenants use the editor and can then be unbound.
 */
export async function getGitHubConnection(env: PluginEnv): Promise<GitHubConnection | null> {
  const stored = await pluginState(env, PLUGIN_ID).get<unknown>(CONNECTION_STATE_KEY);
  const hosted = parseConnection(stored);
  if (hosted) return hosted;

  const legacy = parseConnection(await readLegacyConnection(env));
  if (!legacy) return null;
  // Best-effort: a host that cannot take the write still gets to use the
  // connection it already has, and the next request tries again.
  await putGitHubConnection(env, legacy).catch((error: unknown) => {
    console.warn('Could not migrate the GitHub connection to the CMS:', error);
  });
  return legacy;
}

async function readLegacyConnection(env: PluginEnv): Promise<unknown> {
  const key = legacyConnectionKey(env);
  if (!env.GITHUB_CONNECTIONS || !key) return null;
  return env.GITHUB_CONNECTIONS.get(key, 'json').catch(() => null);
}

/** Pre-migration KV key: `github:<tenant ref>`. */
function legacyConnectionKey(env: PluginEnv): string {
  const ref = env.CMS_TENANT_REF?.trim() ?? '';
  return ref ? `${CONNECTION_KEY_PREFIX}${ref}` : '';
}

/** Validates a stored record; anything malformed reads as "not connected". */
function parseConnection(raw: unknown): GitHubConnection | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<GitHubConnection>;
  if (
    !Number.isSafeInteger(value.installationId)
    || Number(value.installationId) <= 0
    || typeof value.accountLogin !== 'string'
    || typeof value.accountType !== 'string'
    || (value.repositorySelection !== 'all' && value.repositorySelection !== 'selected')
    || typeof value.manageUrl !== 'string'
    || typeof value.connectedAt !== 'string'
  ) {
    return null;
  }
  return value as GitHubConnection;
}

async function putGitHubConnection(env: PluginEnv, connection: GitHubConnection): Promise<void> {
  await pluginState(env, PLUGIN_ID).put(CONNECTION_STATE_KEY, connection);
}

async function exchangeUserCode(config: GitHubAppConfig, code: string): Promise<string> {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
    }),
  });
  const body = await response.json().catch(() => null) as {
    access_token?: unknown;
    error_description?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok || typeof body?.access_token !== 'string' || !body.access_token) {
    const detail = typeof body?.error_description === 'string'
      ? body.error_description
      : typeof body?.error === 'string' ? body.error : `GitHub responded ${response.status}`;
    throw new GitHubError(`GitHub authorization failed: ${detail}.`, response.status);
  }
  return body.access_token;
}

async function userInstallations(token: string): Promise<GitHubInstallation[]> {
  const installations: GitHubInstallation[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await githubApi<{
      total_count?: number;
      installations?: GitHubInstallation[];
    }>(`/user/installations?per_page=100&page=${page}`, token);
    const batch = Array.isArray(result.installations) ? result.installations : [];
    installations.push(...batch);
    if (batch.length < 100 || installations.length >= (result.total_count ?? 0)) break;
  }
  return installations;
}

async function installationToken(config: GitHubAppConfig, installationId: number): Promise<string> {
  const jwt = await appJwt(config);
  const result = await githubApi<{ token?: unknown }>(
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    { method: 'POST' },
  );
  if (typeof result.token !== 'string' || !result.token) {
    throw new GitHubError('GitHub did not return an installation access token.');
  }
  return result.token;
}

async function installationRepositories(
  config: GitHubAppConfig,
  installationId: number,
): Promise<GitHubRepository[]> {
  const token = await installationToken(config, installationId);
  const repositories: GitHubRepository[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await githubApi<{
      total_count?: number;
      repositories?: Array<{
        id?: unknown;
        full_name?: unknown;
        name?: unknown;
        private?: unknown;
        default_branch?: unknown;
        owner?: { login?: unknown };
      }>;
    }>(`/installation/repositories?per_page=100&page=${page}`, token);
    const batch = (Array.isArray(result.repositories) ? result.repositories : [])
      .flatMap((repository): GitHubRepository[] => {
        const id = Number(repository.id);
        const fullName = typeof repository.full_name === 'string' ? repository.full_name : '';
        const owner = typeof repository.owner?.login === 'string' ? repository.owner.login : '';
        const name = typeof repository.name === 'string' ? repository.name : '';
        if (!Number.isSafeInteger(id) || id <= 0 || !fullName || !owner || !name) return [];
        return [{
          id,
          fullName,
          owner,
          name,
          defaultBranch: typeof repository.default_branch === 'string'
            ? repository.default_branch
            : 'main',
          private: repository.private === true,
        }];
      });
    repositories.push(...batch);
    if (batch.length < 100 || repositories.length >= (result.total_count ?? 0)) break;
  }
  return repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

async function appJwt(config: GitHubAppConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlJson({
    iat: now - 60,
    exp: now + (9 * 60),
    iss: config.appId,
  });
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    arrayBuffer(pemBytes(config.privateKey)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
}

async function githubApi<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': API_VERSION,
      'user-agent': 'cms-plugin-theme-editor',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new GitHubError(
      `GitHub ${init.method ?? 'GET'} ${path} responded ${response.status}. ${detail.slice(0, 200)}`,
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

async function signState(payload: GitHubState, secret: string): Promise<string> {
  const encoded = base64UrlJson(payload);
  const key = await stateKey(secret, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded));
  return `${encoded}.${base64UrlBytes(new Uint8Array(signature))}`;
}

async function verifyState(value: string, secret: string): Promise<GitHubState | null> {
  const [encoded, signature, extra] = value.split('.');
  if (!encoded || !signature || extra !== undefined) return null;
  try {
    const encodedBytes = base64UrlDecode(encoded);
    const signatureBytes = base64UrlDecode(signature);
    // Reject alternate non-canonical encodings whose ignored padding bits
    // decode to the same bytes. This keeps every signed state single-valued.
    if (
      base64UrlBytes(encodedBytes) !== encoded
      || base64UrlBytes(signatureBytes) !== signature
    ) {
      return null;
    }
    const key = await stateKey(secret, ['verify']);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      arrayBuffer(signatureBytes),
      new TextEncoder().encode(encoded),
    );
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(encodedBytes)) as Partial<GitHubState>;
    const now = Math.floor(Date.now() / 1000);
    if (
      parsed.v !== 1
      || typeof parsed.tenantId !== 'string'
      || !parsed.tenantId
      || typeof parsed.userId !== 'string'
      || typeof parsed.nonce !== 'string'
      || parsed.nonce.length < 16
      || typeof parsed.iat !== 'number'
      || typeof parsed.exp !== 'number'
      || parsed.iat > now + 60
      || parsed.exp < now
      || parsed.exp - parsed.iat > STATE_LIFETIME_SECONDS
    ) {
      return null;
    }
    return parsed as GitHubState;
  } catch {
    return null;
  }
}

function stateKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

function pemBytes(value: string): Uint8Array {
  const normalized = value.replace(/\\n/g, '\n');
  const pkcs1 = normalized.includes('-----BEGIN RSA PRIVATE KEY-----');
  const base64 = normalized
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/, '')
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  if (!base64) throw new GitHubError('GITHUB_APP_PRIVATE_KEY is not a PEM private key.');
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return pkcs1 ? pkcs1ToPkcs8(bytes) : bytes;
}

/** WebCrypto imports PKCS#8; GitHub currently downloads RSA keys as PKCS#1. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  );
  const privateKey = derValue(0x04, pkcs1);
  return derValue(0x30, concatBytes(version, rsaAlgorithm, privateKey));
}

function derValue(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag), derLength(value.length), value);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function randomBase64Url(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64UrlBytes(bytes);
}

function positiveInt(value: string | null): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function safeGitHubUrl(value: string | undefined): string {
  if (!value) return 'https://github.com/settings/installations';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com'
      ? url.href
      : 'https://github.com/settings/installations';
  } catch {
    return 'https://github.com/settings/installations';
  }
}

function redirectToTenant(tenant: Tenant, message: string): Response {
  const location = `${tenant.cmsUrl.replace(/\/+$/, '')}${ADMIN_BASE}`
    + `?flash=${encodeURIComponent(message)}`;
  return new Response(null, {
    status: 302,
    headers: { ...noStoreHeaders(), location },
  });
}

function callbackError(message: string, status: number): Response {
  return new Response(message, { status, headers: noStoreHeaders() });
}

function noStoreHeaders(): Record<string, string> {
  return { 'cache-control': 'no-store' };
}

function githubAppMessage(error: unknown): string {
  if (error instanceof GitHubError) return error.message;
  return error instanceof Error ? error.message : 'The GitHub connection failed.';
}

export { CALLBACK_PATH as GITHUB_CALLBACK_PATH };
