import { parseAmount } from './export/model';
import type { Report } from './report';

/**
 * Turns raw tabular data (strings copied from Zoho output) into what people see: formatted cells,
 * group subtotals and a grand total. Pure and format-agnostic, so the on-screen table, the CSV and
 * the PDF are all built from the same DisplayTable and cannot drift apart.
 */

export type ColumnType = 'text' | 'number' | 'currency' | 'date' | 'percent';
export type ColumnSpec = { label: string; type: ColumnType; currency?: string };
export type DisplayColumn = { label: string; align: 'left' | 'right' };
export type DisplayRow = { kind: 'data' | 'subtotal' | 'total'; cells: string[] };
export type DisplayTable = { columns: DisplayColumn[]; rows: DisplayRow[] };

/* ----------------------------- formatting ----------------------------- */

const SYMBOL_TO_CODE: Record<string, string> = { '₹': 'INR', $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
const LOCALE: Record<string, string> = { INR: 'en-IN', GBP: 'en-GB', EUR: 'en-IE' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const toNumber = (raw: string): number | undefined => parseAmount(raw.replace(/%/g, ''))?.value;

export function detectCurrency(cells: string[]): string | undefined {
  for (const c of cells) {
    for (const [symbol, code] of Object.entries(SYMBOL_TO_CODE)) if (c.includes(symbol)) return code;
    const m = c.match(/\b(INR|USD|EUR|GBP|JPY|AUD|CAD|AED)\b/);
    if (m) return m[1];
  }
  return undefined;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function formatNumber(n: number, max = 2): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: max });
}

export function formatMoney(n: number, currency?: string): string {
  const value = round2(n);
  if (!currency) return formatNumber(value);
  try {
    return new Intl.NumberFormat(LOCALE[currency] ?? 'en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${formatNumber(value)}`;
  }
}

/** ISO dates ("2026-10-28", "2026-10-28T09:00:00Z") -> "28 Oct 2026". Anything else is left alone. */
export function formatDate(raw: string): string | undefined {
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const month = MONTHS[Number(mo) - 1];
  if (!month || Number(d) < 1 || Number(d) > 31) return undefined;
  return `${Number(d)} ${month} ${y}`;
}

export function formatCell(raw: string, col: ColumnSpec, currency?: string): string {
  const v = raw.trim();
  if (!v) return '';
  const n = toNumber(v);
  switch (col.type) {
    case 'currency':
      return n === undefined ? v : formatMoney(n, currency);
    case 'number':
      return n === undefined ? v : formatNumber(n);
    case 'percent':
      return n === undefined ? v : `${formatNumber(n, 1)}%`;
    case 'date':
      return formatDate(v) ?? v;
    default:
      return v;
  }
}

/* --------------------------- build the table --------------------------- */

const isNumericType = (t: ColumnType) => t === 'currency' || t === 'number';

export type BuildInput = {
  columns: ColumnSpec[];
  rows: string[][];
  groupBy?: string;
  totals?: boolean;
  rowLimit?: number;
};

export type BuildResult = { table: DisplayTable; shown: number; available: number; notes: string[] };

export function buildDisplayTable(input: BuildInput): BuildResult {
  const notes: string[] = [];
  const width = input.columns.length;

  let rows = input.rows.map(r => Array.from({ length: width }, (_, i) => String(r[i] ?? '').trim()));
  const ragged = input.rows.filter(r => r.length !== width).length;
  if (ragged) notes.push(`${ragged} row(s) had a different number of cells than columns; missing cells are blank.`);

  const available = rows.length;
  if (input.rowLimit && rows.length > input.rowLimit) {
    rows = rows.slice(0, input.rowLimit);
    notes.push(`Showing the first ${input.rowLimit} of ${available} rows.`);
  }

  // Per-column currency and "can this column be summed?"
  const currencies = input.columns.map((c, i) =>
    c.type === 'currency' ? (c.currency?.toUpperCase() ?? detectCurrency(rows.map(r => r[i]))) : undefined,
  );
  const summable = input.columns.map((c, i) => {
    if (!isNumericType(c.type)) return false;
    const cells = rows.map(r => r[i]).filter(Boolean);
    return cells.length > 0 && cells.every(x => toNumber(x) !== undefined);
  });
  const hasSummable = summable.some(Boolean);

  // Group (stable, by first appearance)
  let groupIdx = -1;
  if (input.groupBy) {
    groupIdx = input.columns.findIndex(c => c.label.trim().toLowerCase() === input.groupBy!.trim().toLowerCase());
    if (groupIdx < 0) notes.push(`Couldn't group by "${input.groupBy}": no such column.`);
  }
  const groups: { key: string; rows: string[][] }[] = [];
  if (groupIdx >= 0) {
    for (const r of rows) {
      const key = r[groupIdx] || '(blank)';
      (groups.find(g => g.key === key) ?? groups[groups.push({ key, rows: [] }) - 1]).rows.push(r);
    }
  } else {
    groups.push({ key: '', rows });
  }

  const fmt = (r: string[]) => r.map((c, i) => formatCell(c, input.columns[i], currencies[i]));
  const sums = (rs: string[][]) =>
    input.columns.map((c, i) => {
      if (!summable[i]) return '';
      const total = rs.reduce((s, r) => s + (toNumber(r[i]) ?? 0), 0);
      return c.type === 'currency' ? formatMoney(total, currencies[i]) : formatNumber(round2(total));
    });
  const labelIdx = Math.max(0, summable.findIndex(s => !s));
  const summaryRow = (kind: 'subtotal' | 'total', label: string, rs: string[][]): DisplayRow => {
    const cells = sums(rs);
    cells[labelIdx] = label;
    return { kind, cells };
  };

  const out: DisplayRow[] = [];
  for (const g of groups) {
    g.rows.forEach(r => out.push({ kind: 'data', cells: fmt(r) }));
    if (groupIdx >= 0 && hasSummable) out.push(summaryRow('subtotal', `Subtotal - ${g.key} (${g.rows.length})`, g.rows));
  }
  if (input.totals !== false && hasSummable && rows.length >= 2) out.push(summaryRow('total', 'Total', rows));

  return {
    table: {
      columns: input.columns.map(c => ({ label: c.label, align: isNumericType(c.type) || c.type === 'percent' ? 'right' : 'left' })),
      rows: out,
    },
    shown: rows.length,
    available,
    notes,
  };
}

/* ------------------------ exports use the same table ------------------------ */

/** Adapts a displayed table to the Report shape so the existing CSV/PDF exporters can be reused. */
export function tableToReport(args: {
  title: string;
  summary?: string;
  table: DisplayTable;
  notes?: string[];
  sources?: Report['sources'];
  generatedAt?: string;
  status?: Report['status'];
}): Report {
  return {
    status: args.status ?? 'complete',
    generatedAt: args.generatedAt,
    title: args.title,
    summary: args.summary ?? '',
    metrics: [],
    sections: args.table.rows.length
      ? [{ heading: 'Results', table: { columns: args.table.columns.map(c => c.label), rows: args.table.rows.map(r => r.cells) } }]
      : [],
    insights: [],
    caveats: args.notes ?? [],
    sources: args.sources ?? [],
  };
}
