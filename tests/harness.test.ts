import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolSet } from 'ai';
import { tool } from 'ai';
import { z } from 'zod';
import { NoToolsError, NotConnectedError, ZohoToolError } from '../src/lib/errors';
import { Ledger, MAX_RESULT_CHARS, friendlyError, selectTools, classifyResult, guardTools, redact } from '../src/lib/harness';
import { createSubmitReport, finalReportSchema } from '../src/lib/report';

const text = (t: string, extra = {}) => ({ content: [{ type: 'text', text: t }], ...extra });
const opts = { toolCallId: 't1', messages: [], context: {} };
const goodReport = {
  title: 'Pipeline', summary: 's', metrics: [{ label: 'Open deals', value: '3' }],
  sections: [], insights: [], caveats: ['model caveat'],
};

test('classifyResult separates ok / empty / error', () => {
  assert.equal(classifyResult(text('{"data":[{"id":"1"}],"info":{"count":1}}')).status, 'ok');
  assert.equal(classifyResult(text('{"data":[],"info":{"count":0}}')).status, 'empty');
  assert.equal(classifyResult(text('[]')).status, 'empty');
  assert.equal(classifyResult(text('No records found')).status, 'empty');
  assert.equal(classifyResult(text('')).status, 'empty');
  assert.equal(classifyResult(text('Deal: Acme, $5000')).status, 'ok');
  assert.equal(classifyResult(text('boom', { isError: true })).status, 'error');
});

test('redact strips MCP keys and bearer tokens', () => {
  process.env.ZOHO_MCP_URL = 'https://x.zohomcp.com/mcp/message?key=SUPERSECRETKEY123';
  const out = redact('fetch failed https://x.zohomcp.com/mcp/message?key=SUPERSECRETKEY123 Authorization: Bearer abc.def-ghi');
  assert.ok(!out.includes('SUPERSECRETKEY123'), out);
  assert.ok(!out.includes('abc.def-ghi'), out);
});

test('guardTools: failure is recorded, redacted, and thrown as a "do not guess" error', async () => {
  process.env.ZOHO_MCP_URL = 'https://x.zohomcp.com/mcp/message?key=SUPERSECRETKEY123';
  const ledger = new Ledger();
  const tools = guardTools({
    crm_deals: { execute: async () => { throw new Error('401 at https://x.zohomcp.com/mcp/message?key=SUPERSECRETKEY123'); } },
  } as unknown as ToolSet, ledger);
  await assert.rejects(() => (tools.crm_deals.execute as Function)({}, opts), (e: Error) => {
    assert.match(e.message, /Do not guess/);
    assert.ok(!e.message.includes('SUPERSECRETKEY123'));
    return true;
  });
  assert.deepEqual(ledger.calls.map(c => c.status), ['error']);
});

test('guardTools: isError result is treated as failure; empty is labelled; ok passes through', async () => {
  const ledger = new Ledger();
  const tools = guardTools({
    bad: { execute: async () => text('invalid module', { isError: true }) },
    none: { execute: async () => text('{"data":[]}') },
    fine: { execute: async () => text('{"data":[{"id":1}]}') },
  } as unknown as ToolSet, ledger);
  await assert.rejects(() => (tools.bad.execute as Function)({}, opts), /failed/);
  const empty = await (tools.none.execute as Function)({}, opts);
  assert.equal(empty.harnessStatus, 'empty');
  assert.match(empty.content[0].text, /NO DATA/);
  const ok = await (tools.fine.execute as Function)({}, opts);
  assert.equal(ok.content[0].text, '{"data":[{"id":1}]}');
  assert.deepEqual(ledger.calls.map(c => c.status), ['error', 'empty', 'ok']);
});

test('submit_report gate: refuses before any Zoho call', async () => {
  const submit = createSubmitReport(new Ledger());
  await assert.rejects(() => submit.execute!(goodReport, opts) as Promise<unknown>, /No Zoho data/);
});

test('submit_report gate: only failures/empties -> honest no_data report, model figures dropped', async () => {
  const ledger = new Ledger();
  ledger.record('crm_deals', 'error', '503');
  ledger.record('projects', 'empty');
  const r = finalReportSchema.parse(await createSubmitReport(ledger).execute!(goodReport, opts));
  assert.equal(r.status, 'no_data');
  assert.equal(r.metrics.length, 0);
  assert.ok(r.caveats.some(c => c.includes('crm_deals') && c.includes('failed')));
  assert.ok(r.caveats.some(c => c.includes('projects') && c.includes('no records')));
});

test('submit_report gate: with data, harness attaches sources and failure caveats', async () => {
  const ledger = new Ledger();
  ledger.record('crm_deals', 'ok');
  ledger.record('projects', 'error', 'timeout');
  const r = finalReportSchema.parse(await createSubmitReport(ledger).execute!(goodReport, opts));
  assert.equal(r.status, 'complete');
  assert.deepEqual(r.sources.map(s => [s.tool, s.ok, s.failed]), [['crm_deals', 1, 0], ['projects', 0, 1]]);
  assert.ok(r.caveats.includes('model caveat') && r.caveats.some(c => c.includes('projects')));
});

test('submit_report gate: forceFinal with zero calls still concludes (no dead loop)', async () => {
  const ledger = new Ledger();
  ledger.forceFinal = true;
  const r = finalReportSchema.parse(await createSubmitReport(ledger).execute!(goodReport, opts));
  assert.equal(r.status, 'no_data');
});



test('selectTools: read-only by default; drops write tools and oversized schemas', () => {
  const t = (shape: z.ZodRawShape = {}) => tool({ description: 'x', inputSchema: z.object(shape), execute: async () => 'ok' });
  const huge = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`field_${i}_${'x'.repeat(40)}`, z.string()]));
  const all = {
    ZohoCRM_getRecords: t(), ZohoCRM_searchRecords: t(), Projects_listTasks: t(), ZohoCRM_runSpecificReport: t(),
    ZohoCRM_getBigThing: t(huge),
    ZohoCRM_createReports: t(), ZohoCRM_deleteReport: t(), ZohoCRM_updateDeals: t(), ZohoCRM_refreshReport: t(),
    ZohoCRM_getawayCar: t(), // "get" must be a whole word, not a prefix of "getaway"
  } as unknown as ToolSet;
  const { tools, dropped } = selectTools(all);
  assert.deepEqual(Object.keys(tools).sort(), ['Projects_listTasks', 'ZohoCRM_getRecords', 'ZohoCRM_runSpecificReport', 'ZohoCRM_searchRecords']);
  assert.equal(dropped.find(d => d.name === 'ZohoCRM_getBigThing')?.reason, 'schema-too-large');
  assert.equal(dropped.find(d => d.name === 'ZohoCRM_deleteReport')?.reason, 'write-tool');
  assert.ok(dropped.some(d => d.name === 'ZohoCRM_getawayCar'));
  assert.ok('ZohoCRM_createReports' in selectTools(all, { allowWrites: true }).tools);
});

test('classifyResult: failure envelopes without isError are errors', () => {
  const body = (o: object) => ({ content: [{ type: 'text', text: JSON.stringify(o) }], structuredContent: o });
  assert.equal(classifyResult(body({ status: 'failure', data: { code: 'OAUTH_SCOPE_MISMATCH', message: 'invalid scope' } })).status, 'error');
  assert.equal(classifyResult(body({ code: 'INVALID_TOKEN', message: 'bad', status: 'error' })).status, 'error');
  assert.equal(classifyResult(body({ code: 'NOT_FOUND', message: 'no such module' })).status, 'error');
  // real data and success envelopes are not misread as failures
  assert.equal(classifyResult(body({ data: [{ id: '1', Stage: 'Closed Won' }] })).status, 'ok');
  assert.equal(classifyResult(body({ code: 'SUCCESS', message: 'record added', status: 'success' })).status, 'ok');
});

test('selectTools: classifies by verbs in the name, however many prefix segments', () => {
  const t = () => tool({ description: 'x', inputSchema: z.object({}), execute: async () => 'ok' });
  const all = Object.fromEntries(
    ['Zoho_CRM_getRecords', 'ZohoCRM_Deals_searchRecords', 'Zoho_Projects_list_tasks', 'ZohoCRM_getDeletedReports',
     'ZohoCRM_getAndUpdateDeal', 'ZohoCRM_Deals_createRecord', 'ZohoCRM_refreshReport', 'ZohoCRM_markReportsAsFavorite', 'mystery']
      .map(n => [n, t()]),
  ) as unknown as ToolSet;
  assert.deepEqual(Object.keys(selectTools(all).tools).sort(),
    ['ZohoCRM_Deals_searchRecords', 'ZohoCRM_getDeletedReports', 'Zoho_CRM_getRecords', 'Zoho_Projects_list_tasks']);
  const hinted = { weird_thing: Object.assign(t(), { annotations: { readOnlyHint: true } }), getBoom: Object.assign(t(), { annotations: { destructiveHint: true } }) } as unknown as ToolSet;
  assert.deepEqual(Object.keys(selectTools(hinted).tools), ['weird_thing']);
});

test('friendlyError: typed errors, no instructions leaked, no misrouting by keyword', () => {
  assert.match(friendlyError(new NotConnectedError('http://x/api/zoho/connect')), /http:\/\/x\/api\/zoho\/connect/);
  assert.match(friendlyError(new NoToolsError()), /no tools/);
  const e = new ZohoToolError('ZohoCRM_getRecords', 'OAUTH_SCOPE_MISMATCH: invalid scope');
  assert.match(e.message, /Do not guess/, 'the model still gets the instruction');
  assert.equal(friendlyError(e), 'Zoho tool "ZohoCRM_getRecords" failed: OAUTH_SCOPE_MISMATCH: invalid scope');
  assert.ok(!/AI model/.test(friendlyError(new Error('Deal model "Enterprise" not found'))));
  assert.match(friendlyError(new Error('You exceeded your current quota (429)')), /AI model request failed/);
});

test('guardTools: oversized results are truncated and flagged in caveats', async () => {
  const ledger = new Ledger();
  const big = 'x'.repeat(MAX_RESULT_CHARS * 2);
  const tools = guardTools({ crm_get: { execute: async () => text(`{"data":[{"note":"${big}"}]}`) } } as unknown as ToolSet, ledger);
  const out = await (tools.crm_get.execute as Function)({}, opts);
  assert.ok(out.content[0].text.length < MAX_RESULT_CHARS + 200);
  assert.match(out.content[0].text, /TRUNCATED/);
  assert.ok(ledger.caveats().some(c => c.includes('crm_get') && c.includes('truncated')));
});
