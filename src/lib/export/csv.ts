import type { Report } from '../report';
import { formatGeneratedAt, normalizedRows } from './model';

/**
 * CSV for Excel / Google Sheets. One file, laid out as labelled blocks (summary, metrics, then each
 * table with its own header row). Every row is padded to the same width so the grid stays aligned.
 * Output starts with a UTF-8 BOM (Excel needs it for non-ASCII) and uses CRLF line endings.
 */

const NUMBERISH = /^[+-]?[\d$€£₹¥.,\s()%-]+$/;

/** Neutralise spreadsheet formula injection: report cells can contain attacker-controlled CRM text. */
function guardFormula(value: string): string {
  if (/^[=@\t\r]/.test(value)) return `'${value}`;
  if (/^[+-]/.test(value) && !NUMBERISH.test(value)) return `'${value}`;
  return value;
}

function cell(value: string | number | undefined): string {
  const text = guardFormula(String(value ?? ''));
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function reportToCsv(report: Report, now = new Date()): string {
  const blocks: string[][][] = [];
  const block = (...rows: string[][]) => blocks.push(rows);

  block(['Report', report.title], ['Generated', formatGeneratedAt(report, now)]);
  if (report.summary.trim()) block(['Summary'], [report.summary]);

  if (report.metrics.length) {
    block(['Metrics'], ['Metric', 'Value', 'Note'], ...report.metrics.map(m => [m.label, m.value, m.note ?? '']));
  }

  for (const s of report.sections) {
    const rows: string[][] = [[s.heading]];
    if (s.body?.trim()) rows.push([s.body]);
    if (s.table?.columns.length) rows.push(s.table.columns, ...normalizedRows(s.table));
    block(...rows);
  }

  if (report.insights.length) block(['Insights'], ...report.insights.map(t => [t]));
  if (report.caveats.length) block(['Caveats'], ...report.caveats.map(t => [t]));
  if (report.sources.length) {
    block(
      ['Sources (Zoho tools)'],
      ['Tool', 'OK', 'Empty', 'Failed'],
      ...report.sources.map(s => [s.tool, String(s.ok), String(s.empty), String(s.failed)]),
    );
  }

  const width = Math.max(...blocks.flat().map(r => r.length));
  const toLine = (r: string[]) => Array.from({ length: width }, (_, i) => cell(r[i])).join(',');
  const spacer = ','.repeat(width - 1);
  const lines = blocks.flatMap((rows, i) => [...(i ? [spacer] : []), ...rows.map(toLine)]);
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
