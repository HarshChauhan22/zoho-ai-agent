import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ZOHO_SCOPE, ZohoOAuthProvider, isConnected, pickScopes } from '../src/lib/zoho-oauth';

const fresh = (origin = 'https://alpha-1.zohomcp.in') => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oauth-'));
  process.env.ZOHO_OAUTH_FILE = path.join(dir, 'zoho-oauth.json');
  process.env.ZOHO_MCP_URL = `${origin}/mcp/${'a'.repeat(32)}/message`;
  return process.env.ZOHO_OAUTH_FILE;
};
const tok = (n: string) => ({ access_token: n, token_type: 'Bearer', refresh_token: `r-${n}` }) as never;

test('concurrent saves are serialized: nothing is lost, nothing throws', async () => {
  const file = fresh();
  const p = new ZohoOAuthProvider();
  const results = await Promise.allSettled([
    p.saveTokens(tok('A')), p.saveState('s1'), p.saveCodeVerifier('v1'), p.saveTokens(tok('B')),
    p.saveState('s2'), p.saveCodeVerifier('v2'),
  ]);
  assert.deepEqual(results.map(r => r.status), Array(6).fill('fulfilled'));
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.tokens.access_token, 'B');
  assert.equal(saved.state, 's2');
  assert.equal(saved.codeVerifier, 'v2');
});

test('credentials from a different MCP server are ignored, then replaced on next sign-in', async () => {
  fresh('https://old-1.zohomcp.in');
  const p = new ZohoOAuthProvider();
  await p.saveTokens(tok('OLD'));
  assert.equal(await isConnected(), true);

  process.env.ZOHO_MCP_URL = `https://new-1.zohomcp.in/mcp/${'b'.repeat(32)}/message`;
  assert.equal(await isConnected(), false, 'stale tokens must not count as connected');
  assert.equal(await p.tokens(), undefined);

  await p.saveTokens(tok('NEW'));
  assert.equal((await p.tokens() as { access_token: string }).access_token, 'NEW');
});

test('invalidateCredentials("tokens") keeps the registered client', async () => {
  fresh();
  const p = new ZohoOAuthProvider();
  await p.saveClientInformation({ client_id: 'cid' } as never);
  await p.saveTokens(tok('A'));
  await p.invalidateCredentials('tokens');
  assert.equal(await p.tokens(), undefined);
  assert.equal((await p.clientInformation() as { client_id: string }).client_id, 'cid');
});

test('a corrupt file is reported, not silently overwritten with empty state', async () => {
  const file = fresh();
  writeFileSync(file, '{not json');
  const p = new ZohoOAuthProvider();
  await assert.rejects(() => p.saveState('x'), /corrupt/);
  assert.equal(readFileSync(file, 'utf8'), '{not json');
});

test('a legacy file with no server marker is treated as signed out', async () => {
  const file = fresh();
  writeFileSync(file, JSON.stringify({ tokens: tok('LEGACY'), state: 's' }));
  assert.equal(await isConnected(), false);
});

test('pickScopes: MCP scope + read scopes only, unless writes are enabled', () => {
  const supported = ['zohocrm.modules.reports.read', 'zohocrm.modules.reports.delete', 'zohocrm.settings.home.update', 'zohocrm.settings.kanban_views.read', ZOHO_SCOPE];
  assert.deepEqual(pickScopes(supported, false).split(' ').sort(),
    [ZOHO_SCOPE, 'zohocrm.modules.reports.read', 'zohocrm.settings.kanban_views.read'].sort());
  assert.equal(pickScopes(supported, true).split(' ').length, 5);
  assert.equal(pickScopes([], false), ZOHO_SCOPE, 'falls back to the MCP scope alone');
});
