import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tool, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';
import { buildAgent } from '../src/lib/agent';
import { ChatText } from '../src/components/chat-text';
import { TableCard } from '../src/components/table-card';
import { reportToCsv } from '../src/lib/export/csv';
import { reportToPdf } from '../src/lib/export/pdf';
import { Ledger } from '../src/lib/harness';
import { splitMarkdownTables } from '../src/lib/markdown-tables';
import { TABLE_TOOL, createPresentTable, tableResultSchema, type TableResult } from '../src/lib/response';
import { buildDisplayTable, formatCell, formatDate, formatMoney, tableToReport } from '../src/lib/table';

/* ------------------------------ fixtures ------------------------------ */

const DEALS = [
  { Deal_Name: 'Acme Rollout', Stage: 'Negotiation', Owner: 'Priya Kumar', Amount: 200000.0, Closing_Date: '2026-10-28' },
  { Deal_Name: 'Globex Renewal', Stage: 'Negotiation', Owner: 'Sam Lee', Amount: 75000.0, Closing_Date: '2026-11-05' },
  { Deal_Name: 'Initech Pilot', Stage: 'Qualification', Owner: 'Lee Chen', Amount: 50000.0, Closing_Date: '2026-12-01' },
  { Deal_Name: 'Umbrella Expansion', Stage: 'Qualification', Owner: 'Priya Kumar', Amount: 60000.0, Closing_Date: '2026-12-15' },
  { Deal_Name: 'Hooli Upgrade', Stage: 'Proposal', Owner: 'Sam Lee', Amount: 40000.0, Closing_Date: '2027-01-10' },
];
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const call = (toolName: string, input: unknown) => ({
  content: [{ type: 'tool-call' as const, toolCallId: `c${Math.random()}`, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage, warnings: [],
});
const say = (t: string) => ({
  content: [{ type: 'text' as const, text: t }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [],
});
const fake = (execute: () => Promise<unknown>) => tool({ description: 'fake zoho tool', inputSchema: z.object({}), execute });
const json = (o: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });
const dealsTool = () => ({ ZohoCRM_runSpecificReport: fake(async () => json({ data: DEALS, info: { count: DEALS.length } })) }) as unknown as ToolSet;
const scripted = (fn: (i: number, o: any) => any) => { let i = 0; return new MockLanguageModelV4({ doGenerate: async (o: any) => fn(i++, o) }); };
const tableFrom = (result: Awaited<ReturnType<ReturnType<typeof buildAgent>['agent']['generate']>>): TableResult =>
  tableResultSchema.parse(result.steps.at(-1)!.toolResults.find(r => r.toolName === TABLE_TOOL)!.output);

const FOUR_COLUMNS = [
  { label: 'Deal Name', type: 'text' }, { label: 'Stage', type: 'text' },
  { label: 'Sales Representative', type: 'text' }, { label: 'Deal Amount', type: 'currency', currency: 'INR' },
] as const;
const dealRows = (n = DEALS.length) => DEALS.slice(0, n).map(d => [d.Deal_Name, d.Stage, d.Owner, String(d.Amount)]);
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

/* ------------------- the requested example, end to end ------------------- */

test('"Show me 3 deals with Deal Name, Stage, Sales Representative, and Deal Amount" -> four real columns, 3 rows', async () => {
  const model = scripted(i =>
    i === 0 ? call('ZohoCRM_runSpecificReport', {})
    // the model returns more rows than asked; the harness enforces the limit
    : call(TABLE_TOOL, { title: 'Deals', columns: FOUR_COLUMNS, rows: dealRows(), rowLimit: 3, totals: false }),
  );
  const { agent } = buildAgent(dealsTool(), { model });
  const result = await agent.generate({ prompt: 'Show me 3 deals with Deal Name, Stage, Sales Representative, and Deal Amount.' });
  const table = tableFrom(result);

  assert.equal(table.status, 'ok');
  assert.deepEqual(table.columns.map(c => c.label), ['Deal Name', 'Stage', 'Sales Representative', 'Deal Amount']);
  assert.equal(table.rows.filter(r => r.kind === 'data').length, 3, 'row limit respected');
  assert.deepEqual(table.rows[0].cells, ['Acme Rollout', 'Negotiation', 'Priya Kumar', '₹2,00,000'], 'INR formatted with lakh grouping');
  assert.ok(table.notes.some(n => /first 3 of 5/.test(n)));

  // what the user actually sees
  const html = renderToStaticMarkup(<TableCard result={table} />);
  assert.equal(count(html, /<th[ >]/g), 4, 'four <th> columns');
  assert.equal(count(html, /<tbody>[\s\S]*<\/tbody>/g), 1);
  assert.equal(count(html.match(/<tbody>([\s\S]*)<\/tbody>/)![1], /<tr/g), 3, 'three body rows');
  assert.equal(count(html.match(/<tbody>([\s\S]*)<\/tbody>/)![1], /<td/g), 12, '3 rows x 4 cells');
  assert.ok(!html.includes('| Deal Name |') && !/\|\s*-{3}/.test(html), 'no raw Markdown table syntax');
  assert.match(html, /Download CSV/);
  assert.match(html, /Download PDF/);
});

/* ------------------------------ chat response ------------------------------ */

test('simple question -> plain chat text: no tools called, no table', async () => {
  const seen: unknown[] = [];
  const model = scripted((_i, o) => { seen.push(o.toolChoice); return say('**Qualification** is the stage where you check that a lead has budget, authority, need and timing.'); });
  const { agent, ledger } = buildAgent(dealsTool(), { model });
  const result = await agent.generate({ prompt: 'What does the Qualification stage mean?' });

  assert.equal(ledger.calls.length, 0, 'no Zoho tool was called');
  assert.equal(result.steps.length, 1);
  assert.ok(seen.every(c => c === undefined || (c as { type?: string }).type === 'auto' || c === 'auto'), 'format is not forced');
  const html = renderToStaticMarkup(<ChatText text={result.text} />);
  assert.match(html, /<strong>Qualification<\/strong>/, 'Markdown is rendered, not shown raw');
  assert.ok(!html.includes('**'));
  assert.ok(!html.includes('<table'));
});

test('quick summary / total stays chat text even though it says "summary"', async () => {
  const model = scripted(i => (i === 0 ? call('ZohoCRM_runSpecificReport', {}) : say('Your 5 open deals total ₹4,25,000.')));
  const { agent } = buildAgent(dealsTool(), { model });
  const result = await agent.generate({ prompt: 'Give me a quick summary of my sales deals.' });
  assert.equal(result.steps.length, 2);
  assert.ok(!result.steps.some(s => s.toolResults.some(r => r.toolName === TABLE_TOOL)));
  assert.ok(!renderToStaticMarkup(<ChatText text={result.text} />).includes('<table'));
});

/* ------------------------ grouped / summary + table ------------------------ */

test('grouped results: contiguous groups with per-group subtotals and a grand total', async () => {
  const model = scripted(i =>
    i === 0 ? call('ZohoCRM_runSpecificReport', {})
    : call(TABLE_TOOL, { title: 'Open deals by stage', columns: FOUR_COLUMNS, rows: [dealRows()[0], dealRows()[2], dealRows()[1], dealRows()[3], dealRows()[4]], groupBy: 'Stage' }),
  );
  const { agent } = buildAgent(dealsTool(), { model });
  const table = tableFrom(await agent.generate({ prompt: 'List open deals grouped by stage' }));

  const lines = table.rows.map(r => `${r.kind}|${r.cells[0]}|${r.cells[1]}|${r.cells[3]}`);
  assert.deepEqual(lines, [
    'data|Acme Rollout|Negotiation|₹2,00,000',
    'data|Globex Renewal|Negotiation|₹75,000',          // regrouped next to its stage
    'subtotal|Subtotal - Negotiation (2)||₹2,75,000',
    'data|Initech Pilot|Qualification|₹50,000',
    'data|Umbrella Expansion|Qualification|₹60,000',
    'subtotal|Subtotal - Qualification (2)||₹1,10,000',
    'data|Hooli Upgrade|Proposal|₹40,000',
    'subtotal|Subtotal - Proposal (1)||₹40,000',
    'total|Total||₹4,25,000',
  ]);
  const html = renderToStaticMarkup(<TableCard result={table} />);
  assert.equal(count(html, /class="subtotal"/g), 3);
  assert.equal(count(html, /class="total"/g), 1);
});

test('summary + table: insight is shown above the table', async () => {
  const model = scripted(i =>
    i === 0 ? call('ZohoCRM_runSpecificReport', {})
    : call(TABLE_TOOL, { title: 'Deals by rep', summary: 'Priya Kumar owns the largest share of the open pipeline.', columns: FOUR_COLUMNS.slice(2).map(c => ({ ...c })), rows: DEALS.map(d => [d.Owner, String(d.Amount)]), groupBy: 'Sales Representative' }),
  );
  const { agent } = buildAgent(dealsTool(), { model });
  const table = tableFrom(await agent.generate({ prompt: 'Compare deals by sales representative' }));
  assert.equal(table.summary, 'Priya Kumar owns the largest share of the open pipeline.');
  const html = renderToStaticMarkup(<TableCard result={table} />);
  assert.ok(html.indexOf('Priya Kumar owns the largest share') < html.indexOf('<table'), 'summary precedes the table');
  assert.equal(count(html, /<th[ >]/g), 2);
});

/* ----------------------- unavailable / empty / errors ----------------------- */

test('Zoho failure -> clear no-data card, no invented rows, no download buttons', async () => {
  const failing = { ZohoCRM_runSpecificReport: fake(async () => { throw new Error('503 upstream'); }) } as unknown as ToolSet;
  const model = scripted(i => (i === 0 ? call('ZohoCRM_runSpecificReport', {}) : call(TABLE_TOOL, { title: 'Deals', columns: FOUR_COLUMNS, rows: dealRows() })));
  const { agent } = buildAgent(failing, { model });
  const table = tableFrom(await agent.generate({ prompt: 'Show me 3 deals' }));
  assert.equal(table.status, 'no_data');
  assert.equal(table.rows.length, 0);
  assert.ok(table.notes.some(n => n.includes('ZohoCRM_runSpecificReport') && n.includes('failed')));
  const html = renderToStaticMarkup(<TableCard result={table} />);
  assert.match(html, /couldn&#x27;t retrieve data from Zoho/);
  assert.ok(!html.includes('<table') && !/Download (CSV|PDF)/.test(html));
});

test('present_table: refuses before any fetch; empty result says so; invented values are flagged', async () => {
  const input = { title: 'Deals', columns: [...FOUR_COLUMNS], rows: dealRows(2) };
  const opts = { toolCallId: 't', messages: [], context: {} };

  await assert.rejects(() => createPresentTable(new Ledger()).execute!(input as never, opts) as Promise<unknown>, /No Zoho data/);

  const empty = new Ledger();
  empty.record('ZohoCRM_runSpecificReport', 'empty');
  const none = (await createPresentTable(empty).execute!(input as never, opts)) as TableResult;
  assert.equal(none.status, 'no_data');

  const ok = new Ledger();
  ok.record('ZohoCRM_runSpecificReport', 'ok');
  ok.addOutput(JSON.stringify({ data: DEALS }));
  const noRecords = (await createPresentTable(ok).execute!({ ...input, rows: [] } as never, opts)) as TableResult;
  assert.equal(noRecords.status, 'no_data');
  assert.match(noRecords.message!, /no matching records/);

  const invented = (await createPresentTable(ok).execute!(
    { ...input, rows: [['Acme Rollout', 'Negotiation', 'Priya Kumar', '200000'], ['Ghost Deal', 'Won', 'Nobody Real', '999999']] } as never, opts)) as TableResult;
  assert.ok(invented.notes.some(n => /4 of 8 values could not be matched/.test(n)), JSON.stringify(invented.notes));
  const real = (await createPresentTable(ok).execute!({ ...input, rows: dealRows(2) } as never, opts)) as TableResult;
  assert.ok(!real.notes.some(n => /could not be matched/.test(n)), 'verbatim values are not flagged');
});

/* ------------------------------- formatting ------------------------------- */

test('currency, date, percent and number formatting', () => {
  assert.equal(formatMoney(200000, 'INR'), '₹2,00,000');
  assert.equal(formatMoney(1234.5, 'USD'), '$1,234.50');
  assert.equal(formatMoney(5000, 'USD'), '$5,000');
  assert.equal(formatCell('50000.0', { label: 'a', type: 'currency' }, 'INR'), '₹50,000');
  assert.equal(formatCell('₹5,000', { label: 'a', type: 'currency' }, 'INR'), '₹5,000');
  assert.equal(formatCell('n/a', { label: 'a', type: 'currency' }, 'INR'), 'n/a', 'unparseable values are shown, not invented');
  assert.equal(formatCell('2026-10-28', { label: 'd', type: 'date' }), '28 Oct 2026');
  assert.equal(formatCell('2026-10-28T09:30:00Z', { label: 'd', type: 'date' }), '28 Oct 2026');
  assert.equal(formatDate('28/10/2026'), undefined, 'ambiguous formats are left alone');
  assert.equal(formatCell('25', { label: 'p', type: 'percent' }), '25%');
  assert.equal(formatCell('12.345', { label: 'p', type: 'percent' }), '12.3%');
  assert.equal(formatCell('1234567', { label: 'n', type: 'number' }), '1,234,567');
  assert.equal(formatCell('', { label: 'n', type: 'number' }), '');
});

test('buildDisplayTable: totals only for fully numeric columns; ids and unknown group columns are safe', () => {
  const r = buildDisplayTable({
    columns: [{ label: 'Deal', type: 'text' }, { label: 'Id', type: 'text' }, { label: 'Amount', type: 'currency', currency: 'USD' }, { label: 'Prob', type: 'percent' }],
    rows: [['a', '101', '10', '20'], ['b', '102', '5.5', '40']],
    groupBy: 'Nope',
  });
  assert.deepEqual(r.table.rows.at(-1)!.cells, ['Total', '', '$15.50', ''], 'ids and percents are not summed');
  assert.ok(r.notes.some(n => /Couldn't group by "Nope"/.test(n)));
  assert.deepEqual(r.table.columns.map(c => c.align), ['left', 'left', 'right', 'right']);
  assert.equal(buildDisplayTable({ columns: [{ label: 'Amount', type: 'currency' }], rows: [['10'], ['n/a']] }).table.rows.at(-1)!.kind, 'data', 'a non-numeric cell disables the total');
});

/* ------------------------ Markdown tables: the safety net ------------------------ */

const MD_TABLE = `Here are your deals:

| Deal Name | Stage | Sales Representative | Deal Amount |
|:--|---|---|--:|
| Acme Rollout | **Negotiation** | Priya Kumar | ₹2,00,000 |
| Globex \\| Renewal | Negotiation | Sam Lee | ₹75,000 |
| Initech Pilot | Qualification | Lee Chen | ₹50,000 |

Let me know if you need more.`;

test('Markdown table in chat text is rendered as a real 4-column table, never raw pipes', () => {
  const html = renderToStaticMarkup(<ChatText text={MD_TABLE} />);
  assert.equal(count(html, /<th[ >]/g), 4);
  assert.equal(count(html.match(/<tbody>([\s\S]*)<\/tbody>/)![1], /<tr/g), 3);
  assert.ok(html.includes('Globex | Renewal'), 'escaped pipe becomes a literal pipe inside the cell');
  assert.ok(!html.includes('| Deal Name |') && !html.includes('|:--|'), 'no raw Markdown table syntax');
  assert.ok(!html.includes('**'), 'inline emphasis markers are stripped from cells');
  assert.match(html, /Here are your deals/);
  assert.match(html, /Let me know if you need more/);
  assert.match(html, /Download CSV/);
  assert.match(html, /Download PDF/);
});

test('splitMarkdownTables: structure-based, with alignment, and no false positives', () => {
  const segs = splitMarkdownTables(MD_TABLE);
  assert.deepEqual(segs.map(s => s.type), ['text', 'table', 'text']);
  const t = (segs[1] as { table: { columns: { label: string; align: string }[]; rows: { cells: string[] }[] } }).table;
  assert.deepEqual(t.columns.map(c => c.align), ['left', 'left', 'left', 'right']);
  assert.deepEqual(t.rows[0].cells, ['Acme Rollout', 'Negotiation', 'Priya Kumar', '₹2,00,000']);
  assert.equal(splitMarkdownTables('a | b is just text\nand so is this | one').length, 1);
  assert.equal(splitMarkdownTables('| a | b |\n| c | d |').filter(s => s.type === 'table').length, 0, 'no delimiter row, not a table');
  assert.equal(splitMarkdownTables('| a | b |\n|---|\n| 1 | 2 |').filter(s => s.type === 'table').length, 0, 'header/delimiter widths differ');
});

/* -------------------------------- downloads -------------------------------- */

test('CSV and PDF contain exactly the displayed table (rows, subtotals, total)', async () => {
  const built = buildDisplayTable({ columns: [...FOUR_COLUMNS], rows: dealRows(), groupBy: 'Stage' });
  const report = tableToReport({ title: 'Open deals by stage', summary: 'Most value is in Negotiation.', table: built.table, notes: ['Closed deals excluded.'], generatedAt: '2026-10-12T14:03:00Z' });

  // CSV: header + every displayed row, cell for cell
  const csvRows = reportToCsv(report).slice(1).split('\r\n').map(l => l.replace(/"/g, ''));
  const start = csvRows.findIndex(l => l.startsWith('Deal Name,Stage,Sales Representative,Deal Amount'));
  assert.ok(start > 0, 'column headers present');
  built.table.rows.forEach((row, i) => {
    assert.ok(csvRows[start + 1 + i].startsWith(row.cells.map(c => c.replace(/"/g, '')).join(',').replace(/,+$/, '')), `CSV row ${i}: ${csvRows[start + 1 + i]}`);
  });
  assert.ok(csvRows.some(l => l.startsWith('Subtotal - Negotiation (2)') && l.includes('₹2,75,000')));
  assert.ok(csvRows.some(l => l.startsWith('Total') && l.includes('₹4,25,000')));

  // PDF: same cells, and no second, double-counting "calculated" total
  const text = [...Buffer.from(await reportToPdf(report)).toString('latin1').matchAll(/\((.*?)\) Tj/g)].map(m => m[1].replace(/\\([()\\])/g, '$1'));
  for (const expected of ['Open deals by stage', 'Most value is in Negotiation.', 'Deal Name', 'Sales Representative', 'Acme Rollout', 'Rs 2,00,000', 'Subtotal - Negotiation (2)', 'Rs 2,75,000', 'Total', 'Rs 4,25,000', 'Closed deals excluded.']) {
    assert.ok(text.includes(expected) || text.includes(`-  ${expected}`), `PDF is missing "${expected}"`);
  }
  assert.ok(!text.includes('Total (calculated)'), 'totals are not counted twice');
});

test('a Markdown-derived table downloads exactly what is shown', () => {
  const seg = splitMarkdownTables(MD_TABLE).find(s => s.type === 'table') as { table: Parameters<typeof tableToReport>[0]['table'] };
  const csv = reportToCsv(tableToReport({ title: 'Table', table: seg.table }));
  assert.match(csv, /Deal Name,Stage,Sales Representative,Deal Amount/);
  assert.match(csv, /Globex \| Renewal,Negotiation,Sam Lee,"₹75,000"/);
});
