import { auth } from '@ai-sdk/mcp';
import { getEnv } from '@/lib/env';
import { friendlyError } from '@/lib/harness';
import { appUrl, ZohoOAuthProvider } from '@/lib/zoho-oauth';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    return Response.json({ ok: false, error: `Zoho denied access: ${oauthError}` }, { status: 400 });
  }
  const code = url.searchParams.get('code');
  if (!code) return Response.json({ ok: false, error: 'Missing ?code from Zoho' }, { status: 400 });

  try {
    const provider = new ZohoOAuthProvider();
    await auth(provider, {
      serverUrl: getEnv().ZOHO_MCP_URL,
      authorizationCode: code,
      callbackState: url.searchParams.get('state') ?? undefined,
      callbackIssuer: url.searchParams.get('iss') ?? undefined,
    });
    return Response.redirect(`${appUrl()}/?connected=1`);
  } catch (err) {
    return Response.json({ ok: false, error: friendlyError(err) }, { status: 502 });
  }
}
