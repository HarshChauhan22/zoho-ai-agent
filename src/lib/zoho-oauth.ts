import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthTokens,
} from '@ai-sdk/mcp';
import { NotConnectedError } from './errors';

/**
 * File-backed OAuth state for the Zoho MCP server (local dev). The store holds live access and
 * refresh tokens: keep `.data/` out of git (it is) and swap this class for a database-backed one
 * before running on serverless hosting, where the filesystem is not persistent.
 *
 * Credentials are bound to the MCP server they were issued by. If ZOHO_MCP_URL points somewhere
 * else, the stored state is ignored (and replaced on the next sign-in).
 */
type Stored = {
  serverOrigin?: string;
  clientInformation?: OAuthClientInformation;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
};

const file = () => process.env.ZOHO_OAUTH_FILE || path.join(process.cwd(), '.data', 'zoho-oauth.json');

function currentOrigin(): string | undefined {
  try {
    return new URL(process.env.ZOHO_MCP_URL ?? '').origin;
  } catch {
    return undefined;
  }
}

async function read(): Promise<Stored> {
  let raw: string;
  try {
    raw = await readFile(file(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  let stored: Stored;
  try {
    stored = JSON.parse(raw);
  } catch {
    throw new Error(`${file()} is corrupt. Delete it and sign in again at /api/zoho/connect.`);
  }
  // Issued by a different MCP server than the one configured now (or by an older version that
  // didn't record it): unusable, treat as signed out.
  if (stored.serverOrigin !== currentOrigin()) return {};
  return stored;
}

// Writes are read-modify-write; run them one at a time so concurrent saves can't clobber each other.
let queue: Promise<unknown> = Promise.resolve();

function patch(update: (s: Stored) => Stored): Promise<void> {
  const run = async () => {
    await mkdir(path.dirname(file()), { recursive: true, mode: 0o700 });
    const next = { ...update(await read()), serverOrigin: currentOrigin() };
    const tmp = `${file()}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(tmp, file());
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

export const appUrl = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
export const ZOHO_SCOPE = 'ZohoMCP.tool.execute';

/**
 * The MCP scope alone isn't enough: Zoho's tools call the CRM API with the user's token, so the
 * token also needs the CRM scopes the server advertises. Read-only scopes unless writes are enabled.
 */
export function pickScopes(supported: string[], allowWrites: boolean): string {
  const wanted = supported.filter(sc => sc === ZOHO_SCOPE || allowWrites || /\.read$/i.test(sc));
  return [...new Set([ZOHO_SCOPE, ...wanted])].join(' ');
}

export async function discoverScope(serverUrl: string, allowWrites: boolean): Promise<string> {
  try {
    const res = await fetch(`${new URL(serverUrl).origin}/.well-known/oauth-protected-resource`, {
      signal: AbortSignal.timeout(10_000),
    });
    const meta = (await res.json()) as { scopes_supported?: string[] };
    return pickScopes(meta.scopes_supported ?? [], allowWrites);
  } catch (err) {
    console.warn('[zoho-oauth] scope discovery failed; requesting only the MCP scope:', err);
    return ZOHO_SCOPE;
  }
}
export const connectUrl = () => `${appUrl()}/api/zoho/connect`;

export class ZohoOAuthProvider implements OAuthClientProvider {
  /** Set by redirectToAuthorization so the connect route can send the browser there. */
  authorizationUrl?: URL;
  /** Space-separated scopes to register and request (set by the connect route). */
  scope = ZOHO_SCOPE;

  get redirectUrl() {
    return `${appUrl()}/api/zoho/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Zoho Agent',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: this.scope,
    };
  }

  async tokens() {
    return (await read()).tokens;
  }
  async saveTokens(tokens: OAuthTokens) {
    await patch(s => ({ ...s, tokens }));
  }
  async clientInformation() {
    return (await read()).clientInformation;
  }
  async saveClientInformation(clientInformation: OAuthClientInformation) {
    await patch(s => ({ ...s, clientInformation }));
  }
  async isClientInformationDynamicallyRegistered() {
    return true;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  async saveCodeVerifier(codeVerifier: string) {
    await patch(s => ({ ...s, codeVerifier }));
  }
  async codeVerifier() {
    const v = (await read()).codeVerifier;
    if (!v) throw new Error('No PKCE verifier saved; start again at /api/zoho/connect');
    return v;
  }
  state() {
    return randomBytes(16).toString('hex');
  }
  async saveState(state: string) {
    await patch(s => ({ ...s, state }));
  }
  async storedState() {
    return (await read()).state;
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier') {
    await patch(s => {
      const next = { ...s };
      if (scope === 'all' || scope === 'tokens') delete next.tokens;
      if (scope === 'all' || scope === 'client') delete next.clientInformation;
      if (scope === 'all' || scope === 'verifier') delete next.codeVerifier;
      return next;
    });
  }
}

export async function isConnected() {
  return Boolean((await read()).tokens);
}

export const notConnected = () => new NotConnectedError(connectUrl());
