import { createMCPClient } from '@ai-sdk/mcp';
import type { ToolSet } from 'ai';
import { getEnv } from './env';
import { selectTools } from './harness';
import { ZohoOAuthProvider, isConnected, notConnected } from './zoho-oauth';

let warnedKeyOverride = false;

/**
 * Opens a client to the Zoho MCP server. Callers must `close()` it when done.
 * Auth: static bearer if ZOHO_MCP_API_KEY is set; OAuth (default) if ZOHO_MCP_AUTH=oauth;
 * nothing if ZOHO_MCP_AUTH=none (key-in-URL endpoints).
 */
export async function connectZohoMcp() {
  const env = getEnv();
  const useOAuth = !env.ZOHO_MCP_API_KEY && env.ZOHO_MCP_AUTH === 'oauth';
  if (env.ZOHO_MCP_API_KEY && env.ZOHO_MCP_AUTH === 'oauth' && !warnedKeyOverride) {
    warnedKeyOverride = true;
    console.warn('[zoho-mcp] ZOHO_MCP_API_KEY is set, so it is sent as a bearer token and OAuth sign-in is NOT used. Clear it if your URL needs OAuth.');
  }
  if (useOAuth && !(await isConnected())) throw notConnected();

  return createMCPClient({
    transport: {
      type: env.ZOHO_MCP_TRANSPORT,
      url: env.ZOHO_MCP_URL,
      headers: env.ZOHO_MCP_API_KEY ? { Authorization: `Bearer ${env.ZOHO_MCP_API_KEY}` } : undefined,
      authProvider: useOAuth ? new ZohoOAuthProvider() : undefined,
    },
    maxRetries: 2,
  });
}

/** Lists the server's tools, keeping only what the agent may use (read-only unless ZOHO_ALLOW_WRITES=true). */
export async function loadZohoTools(mcp: Awaited<ReturnType<typeof connectZohoMcp>>) {
  const all = (await mcp.tools()) as unknown as ToolSet;
  const { tools, dropped } = selectTools(all, { allowWrites: getEnv().ZOHO_ALLOW_WRITES === 'true' });
  return { tools, dropped, total: Object.keys(all).length };
}
