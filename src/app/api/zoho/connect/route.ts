import { auth } from '@ai-sdk/mcp';
import { getEnv } from '@/lib/env';
import { friendlyError } from '@/lib/harness';
import { appUrl, discoverScope, ZohoOAuthProvider } from '@/lib/zoho-oauth';

/** Visit once in a browser: registers this app with Zoho and redirects you to sign in. */
export async function GET() {
  try {
    const env = getEnv();
    const provider = new ZohoOAuthProvider();
    provider.scope = await discoverScope(env.ZOHO_MCP_URL, env.ZOHO_ALLOW_WRITES === 'true');
    // An explicit "connect" means a fresh start: register a new client with the right scopes and
    // never try to refresh old tokens first (a stale connection was impossible to recover from).
    await provider.invalidateCredentials('all');
    const result = await auth(provider, { serverUrl: env.ZOHO_MCP_URL, scope: provider.scope });
    if (result === 'AUTHORIZED') return Response.redirect(`${appUrl()}/?connected=1`);
    if (!provider.authorizationUrl) throw new Error('Zoho did not return an authorization URL');
    return Response.redirect(provider.authorizationUrl.toString());
  } catch (err) {
    return Response.json({ ok: false, error: friendlyError(err) }, { status: 502 });
  }
}
