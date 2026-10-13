import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reportToCsv } from '../src/lib/export/csv';
import { downloadReport } from '../src/lib/export/download';
import { columnTotals, exportFileName, formatGeneratedAt, hasExportableContent, parseAmount } from '../src/lib/export/model';
import { pdfSafe, reportToPdf } from '../src/lib/export/pdf';
import { finalReportSchema, type Report } from '../src/lib/report';

const NOW = new Date('2026-10-12T14:03:00Z');

const report: Report = finalReportSchema.parse({
  title: 'Open Deals by Stage',
  generatedAt: '2026-10-12T14:03:00.000Z',
  summary: 'There are 3 open deals worth Rs 15,000 in total.',
  metrics: [
    { label: 'Open deals', value: '3' },
    { label: 'Pipeline value', value: '₹15,000', note: 'sum of amounts' },
  ],
  sections: [
    {
      heading: 'Negotiation',
      body: 'Two deals are close to signing.',
      table: {
        columns: ['Deal', 'Owner', 'Amount'],
        rows: [
          ['Acme, Inc.', 'Priya "PK" Kumar', '₹5,000'],
          ['Globex\nRenewal', 'Sam', '₹7,500'],
        ],
      },
    },
    { heading: 'Qualification', table: { columns: ['Deal', 'Owner', 'Amount'], rows: [['Initech', 'Lee', '₹2,500']] } },
  ],
  insights: ['Acme is the largest open deal.'],
  caveats: ['Closed deals were excluded.'],
  sources: [{ tool: 'ZohoCRM_getRecords', ok: 2, empty: 0, failed: 0 }],
});

/** Minimal RFC 4180 parser so we test what Excel / Sheets would actually read. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Text drawn into a (uncompressed) jsPDF document. */
const pdfText = (bytes: Uint8Array) =>
  [...Buffer.from(bytes).toString('latin1').matchAll(/\((.*?)\) Tj/g)].map(m => m[1].replace(/\\([()\\])/g, '$1'));

test('CSV: BOM, CRLF, uniform width, and the report\'s real data in labelled blocks', () => {
  const csv = reportToCsv(report, NOW);
  assert.ok(csv.startsWith('﻿'), 'UTF-8 BOM for Excel');
  assert.ok(csv.includes('\r\n') && !/[^\r]\n(?![^"]*"(?:[^"]*"[^"]*")*[^"]*$)/.test(csv.replace(/"[^"]*"/g, '')), 'CRLF line endings');

  const rows = parseCsv(csv.slice(1));
  assert.equal(new Set(rows.map(r => r.length)).size, 1, 'every row has the same number of columns');
  const flat = rows.map(r => r.join('|'));

  assert.deepEqual(rows[0].slice(0, 2), ['Report', 'Open Deals by Stage']);
  assert.deepEqual(rows[1].slice(0, 2), ['Generated', '2026-10-12 14:03 UTC']);
  assert.ok(flat.some(r => r.startsWith('Summary')));
  assert.ok(rows.some(r => r[0] === 'Summary') && rows.some(r => r[0].includes('3 open deals')));

  // metrics block with headers
  const mi = rows.findIndex(r => r[0] === 'Metric');
  assert.deepEqual(rows[mi].slice(0, 3), ['Metric', 'Value', 'Note']);
  assert.deepEqual(rows[mi + 2].slice(0, 3), ['Pipeline value', '₹15,000', 'sum of amounts']);

  // grouped sections: each table has its header row and exact cells (commas, quotes, newlines survive)
  const ni = rows.findIndex(r => r[0] === 'Negotiation');
  assert.deepEqual(rows[ni + 2].slice(0, 3), ['Deal', 'Owner', 'Amount']);
  assert.deepEqual(rows[ni + 3].slice(0, 3), ['Acme, Inc.', 'Priya "PK" Kumar', '₹5,000']);
  assert.deepEqual(rows[ni + 4].slice(0, 3), ['Globex\nRenewal', 'Sam', '₹7,500']);
  const qi = rows.findIndex(r => r[0] === 'Qualification');
  assert.deepEqual(rows[qi + 1].slice(0, 3), ['Deal', 'Owner', 'Amount'], 'no body text, so the header follows the heading');
  assert.deepEqual(rows[qi + 2].slice(0, 3), ['Initech', 'Lee', '₹2,500']);

  assert.ok(rows.some(r => r[0] === 'Acme is the largest open deal.'));
  assert.ok(rows.some(r => r[0] === 'Closed deals were excluded.'));
  assert.deepEqual(rows[rows.findIndex(r => r[0] === 'Tool') + 1].slice(0, 4), ['ZohoCRM_getRecords', '2', '0', '0']);
});

test('CSV: neutralises spreadsheet formulas but leaves real numbers alone', () => {
  const r = finalReportSchema.parse({
    title: 'Inject', summary: 's', metrics: [], insights: [], caveats: [],
    sections: [{ heading: 'h', table: { columns: ['Name', 'Value'], rows: [
      ['=HYPERLINK("http://evil","x")', '-1,200.50'], ['@SUM(A1)', '+91 98765 43210'], ['-cmd|calc', '(300)'],
    ] } }],
  });
  const rows = parseCsv(reportToCsv(r, NOW).slice(1));
  const i = rows.findIndex(x => x[0] === 'Name');
  assert.equal(rows[i + 1][0], `'=HYPERLINK("http://evil","x")`);
  assert.equal(rows[i + 1][1], '-1,200.50', 'negative numbers are untouched');
  assert.equal(rows[i + 2][0], "'@SUM(A1)");
  assert.equal(rows[i + 2][1], '+91 98765 43210', 'phone numbers are untouched');
  assert.equal(rows[i + 3][0], "'-cmd|calc");
});

test('PDF: valid file containing title, date, summary, metrics, tables, insights, sources', async () => {
  const bytes = await reportToPdf(report, NOW);
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
  const text = pdfText(bytes);
  for (const expected of [
    'Open Deals by Stage', 'Generated 2026-10-12 14:03 UTC  |  Source: Zoho', 'Summary',
    'There are 3 open deals worth Rs 15,000 in total.', 'Key metrics', 'Pipeline value', 'Rs 15,000', 'sum of amounts',
    'Negotiation', 'Deal', 'Owner', 'Amount', 'Acme, Inc.', 'Priya "PK" Kumar', 'Rs 5,000', 'Rs 7,500', 'Initech',
    'Insights', '-  Acme is the largest open deal.', 'Caveats', '-  Closed deals were excluded.', 'ZohoCRM_getRecords', 'Page 1 of 1',
  ]) assert.ok(text.includes(expected), `PDF is missing "${expected}"`);
});

test('PDF: calculated totals row is shown and correct', async () => {
  const text = pdfText(await reportToPdf(report, NOW));
  assert.ok(text.includes('Total (calculated)'));
  assert.ok(text.includes('Rs 12,500'), '5,000 + 7,500');
  assert.ok(text.includes('Rs 2,500'));
});

test('PDF: long tables paginate; unsupported characters degrade safely', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => [`Deal ${i + 1}`, `₹${(i + 1) * 100}`]);
  const big = finalReportSchema.parse({
    title: 'Big 🎉 report — ₹', summary: 'many rows', metrics: [], insights: [], caveats: [],
    sections: [{ heading: 'All', table: { columns: ['Deal', 'Amount'], rows } }],
  });
  const text = pdfText(await reportToPdf(big, NOW));
  assert.ok(text.includes('Deal 1') && text.includes('Deal 120'), 'first and last rows present');
  assert.ok(text.some(t => /^Page \d+ of [2-9]$/.test(t)), 'multiple pages');
  assert.ok(text.includes('Big ? report - Rs '), 'emoji -> ?, em dash -> -, rupee -> Rs');
  assert.equal(pdfSafe('Zoë – ₹5'), 'Zoë - Rs 5');
});

test('exports contain only report fields: no secrets or extra properties', async () => {
  process.env.ZOHO_MCP_URL = 'https://x.zohomcp.in/mcp/0123456789abcdef0123456789abcdef/message';
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'AIzaSyFAKEKEYFORTESTING1234567890';
  const dirty = { ...report, apiKey: 'sk-SECRET-123', env: { ZOHO_MCP_URL: process.env.ZOHO_MCP_URL } } as unknown as Report;
  const csv = reportToCsv(dirty, NOW);
  const pdf = Buffer.from(await reportToPdf(dirty, NOW)).toString('latin1');
  for (const secret of ['sk-SECRET-123', '0123456789abcdef0123456789abcdef', 'AIzaSyFAKEKEYFORTESTING', 'zohomcp.in']) {
    assert.ok(!csv.includes(secret), `CSV leaked ${secret}`);
    assert.ok(!pdf.includes(secret), `PDF leaked ${secret}`);
  }
});

test('exportable-content rules and "no data" handling', async () => {
  assert.equal(hasExportableContent(report), true);
  assert.equal(hasExportableContent(undefined), false);
  assert.equal(hasExportableContent({ ...report, status: 'no_data' }), false);
  const empty = finalReportSchema.parse({ title: 't', summary: '  ', metrics: [], sections: [], insights: [], caveats: [] });
  assert.equal(hasExportableContent(empty), false);
  assert.equal(hasExportableContent({ ...empty, summary: 'just a summary' }), true);
  await assert.rejects(() => downloadReport({ ...report, status: 'no_data' }, 'csv'), /no report data to export/);
  await assert.rejects(() => downloadReport(empty, 'pdf'), /no report data to export/);
});

test('column totals: only consistent numeric columns, labelled, never for ids/percentages', () => {
  const t = (columns: string[], rows: string[][]) => columnTotals({ columns, rows });
  assert.deepEqual(t(['Deal', 'Amount'], [['a', '$1,200.50'], ['b', '$300.25']]), ['Total (calculated)', '$1,500.75']);
  assert.deepEqual(t(['Deal', 'Qty', 'Amount'], [['a', '2', '$10'], ['b', '3', '$5']]), ['Total (calculated)', '5', '$15']);
  assert.equal(t(['Deal', 'Amount'], [['a', '$10'], ['b', '₹5']]), undefined, 'mixed currencies');
  assert.equal(t(['Deal', 'Win rate'], [['a', '10%'], ['b', '20%']]), undefined, 'percentages');
  assert.equal(t(['Deal', 'Deal ID'], [['a', '101'], ['b', '102']]), undefined, 'ids');
  assert.equal(t(['Deal', 'Amount'], [['a', '$10']]), undefined, 'single row');
  assert.equal(t(['Deal', 'Amount'], [['a', '$10'], ['b', 'n/a']]), undefined, 'non-numeric cell');
  assert.equal(t(['Deal', 'Amount'], [['a', '$10'], ['Total', '$10']]), undefined, 'already has a total');
  assert.deepEqual(parseAmount('(300)'), { value: -300, prefix: '', suffix: '' });
  assert.equal(parseAmount('12 Jan 2026'), undefined);
});

test('file names and dates are deterministic', () => {
  assert.equal(exportFileName(report, 'pdf', NOW), 'open-deals-by-stage-2026-10-12.pdf');
  assert.equal(exportFileName({ ...report, title: '🎉 ???' }, 'csv', NOW), 'report-2026-10-12.csv');
  assert.equal(formatGeneratedAt({ ...report, generatedAt: undefined }, NOW), '2026-10-12 14:03 UTC');
});
