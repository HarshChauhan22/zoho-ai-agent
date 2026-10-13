import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { MockLanguageModelV4 } from 'ai/test';
import { MAX_STEPS, buildAgent } from '../src/lib/agent';
import { REPORT_TOOL, finalReportSchema } from '../src/lib/report';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const call = (toolName: string, input: unknown, id = `c${Math.random()}`) => ({
  content: [{ type: 'tool-call' as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: undefined },
  usage, warnings: [],
});
const say = (t: string) => ({
  content: [{ type: 'text' as const, text: t }],
  finishReason: { unified: 'stop' as const, raw: undefined },
  usage, warnings: [],
});
// A report full of invented numbers: the harness must not let these through when nothing was fetched.
const fabricated = {
  title: 'Q3', summary: 'Revenue grew 40%', metrics: [{ label: 'Revenue', value: '$1,000,000' }],
  sections: [], insights: [], caveats: [],
};

const fake = (execute: () => Promise<unknown>) =>
  tool({ description: 'fake zoho tool', inputSchema: z.object({}), execute });
const textResult = (t: string) => ({ content: [{ type: 'text', text: t }] });

const failingTools = {
  crm_deals: fake(async () => { throw new Error('503 upstream'); }),
  projects: fake(async () => textResult('{"data":[]}')),
} as unknown as ToolSet;

function scripted(fn: (i: number, opts: any) => any) {
  let i = 0;
  const model = new MockLanguageModelV4({ doGenerate: async (o: any) => fn(i++, o) });
  return model;
}

test('chat mode: failing tool does not crash the loop; model can explain', async () => {
  const model = scripted(i => (i === 0 ? call('crm_deals', {}) : say('Zoho deals are unavailable right now.')));
  const { agent } = buildAgent(failingTools, { model });
  const result = await agent.generate({ prompt: 'who owns Acme?' });
  assert.match(result.text, /unavailable/);
  assert.equal(result.steps.length, 2);
});

test('report mode: all-fail/empty -> honest no_data report, fabricated figures discarded', async () => {
  const choices: unknown[] = [];
  const model = scripted((i, o) => {
    choices.push(o.toolChoice);
    if (i === 0) return call('crm_deals', {});
    if (i === 1) return call('projects', {});
    return call(REPORT_TOOL, fabricated);
  });
  const { agent } = buildAgent(failingTools, { model, reportMode: true });
  const result = await agent.generate({ prompt: 'pipeline report' });
  const last = result.steps.at(-1)!.toolResults.find(r => r.toolName === REPORT_TOOL)!;
  const report = finalReportSchema.parse(last.output);
  assert.equal(report.status, 'no_data');
  assert.equal(report.metrics.length, 0);
  assert.ok(!JSON.stringify(report).includes('1,000,000'));
  assert.equal(result.steps.length, 3, 'loop stops once the report is delivered');
  assert.ok(choices.every(c => (c as any)?.type === 'required' || c === 'required'), JSON.stringify(choices));
});

test('report mode: model that tries to report before fetching is bounced, then fetches', async () => {
  const okTools = {
    crm_deals: fake(async () => textResult('{"data":[{"Deal_Name":"Acme","Amount":5000}]}')),
  } as unknown as ToolSet;
  const seq = [
    () => call(REPORT_TOOL, fabricated), // premature -> gate throws
    () => call('crm_deals', {}),
    () => call(REPORT_TOOL, { ...fabricated, metrics: [{ label: 'Open pipeline', value: '$5,000' }], summary: '1 deal' }),
  ];
  const model = scripted(i => seq[i]());
  const { agent } = buildAgent(okTools, { model, reportMode: true });
  const result = await agent.generate({ prompt: 'deal summary' });
  const report = finalReportSchema.parse(result.steps.at(-1)!.toolResults.find(r => r.toolName === REPORT_TOOL)!.output);
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.sources, [{ tool: 'crm_deals', ok: 1, empty: 0, failed: 0 }]);
});

test('report mode: a model that never stops calling tools is forced to conclude on the last step', async () => {
  const model = scripted((_i, o) =>
    o.toolChoice?.type === 'tool' ? call(REPORT_TOOL, fabricated) : call('crm_deals', {}),
  );
  const { agent } = buildAgent(failingTools, { model, reportMode: true });
  const result = await agent.generate({ prompt: 'overview' });
  assert.equal(result.steps.length, MAX_STEPS);
  const report = finalReportSchema.parse(result.steps.at(-1)!.toolResults.find(r => r.toolName === REPORT_TOOL)!.output);
  assert.equal(report.status, 'no_data');
});
