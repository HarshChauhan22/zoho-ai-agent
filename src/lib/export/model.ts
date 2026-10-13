import type { Report } from '../report';

/** Shared, format-agnostic helpers for exporting a Report. Pure functions: no DOM, no I/O. */

export type ReportTable = NonNullable<Report['sections'][number]['table']>;

export function hasExportableContent(report: Report | undefined | null): report is Report {
  if (!report || report.status === 'no_data') return false;
  return Boolean(
    report.summary?.trim() ||
      report.metrics?.length ||
      report.insights?.length ||
      report.sections?.some(s => s.body?.trim() || s.table?.rows.length),
  );
}

/** "2026-10-12 14:03 UTC": deterministic, unlike locale formatting. */
export function formatGeneratedAt(report: Report, now = new Date()): string {
  const d = report.generatedAt ? new Date(report.generatedAt) : now;
  const date = Number.isNaN(d.getTime()) ? now : d;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function exportFileName(report: Report, ext: 'csv' | 'pdf', now = new Date()): string {
  const slug =
    report.title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report';
  const d = report.generatedAt ? new Date(report.generatedAt) : now;
  const day = (Number.isNaN(d.getTime()) ? now : d).toISOString().slice(0, 10);
  return `${slug}-${day}.${ext}`;
}

/** Make every row exactly as wide as its header so the grid is consistent. */
export function normalizedRows(table: ReportTable): string[][] {
  const width = table.columns.length;
  return table.rows.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ''));
}

/* ------------------------- calculated totals ------------------------- */

const SKIP_COLUMN = /\b(id|ids|year|zip|postal|phone|mobile|code|no|number|rank|rate|percent|pct|%)\b/i;

/** "$1,200.50", "(300)", "₹ 5,00,000", "-12" -> number; anything else -> undefined. */
export function parseAmount(cell: string): { value: number; prefix: string; suffix: string } | undefined {
  const m = cell.trim().match(/^(\(?)([^\d\-+().]*?)\s*(-?)\s*(\d[\d,]*(?:\.\d+)?)\s*([A-Za-z]{0,3})(\)?)$/);
  if (!m) return undefined;
  const [, open, prefix, minus, digits, suffix, close] = m;
  if (!!open !== !!close) return undefined;
  if (prefix.includes('%') || suffix.includes('%')) return undefined;
  const value = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(value)) return undefined;
  return { value: open || minus ? -value : value, prefix: prefix.trim(), suffix: suffix.trim() };
}

/**
 * Totals for columns whose every non-empty cell is a number with one consistent currency/unit.
 * These are calculated from the rows shown (never fetched), so exports label them as calculated.
 * Returns undefined when no column qualifies.
 */
export function columnTotals(table: ReportTable): string[] | undefined {
  const rows = normalizedRows(table);
  if (rows.length < 2) return undefined;
  // Already has (sub)total rows: don't add a second, double-counting one.
  if (rows.some(r => /^(sub)?total\b/i.test(r.find(c => c.trim()) ?? ''))) return undefined;

  const totals = table.columns.map((col, i) => {
    if (SKIP_COLUMN.test(col)) return undefined;
    const cells = rows.map(r => r[i]).filter(c => c.trim());
    const parsed = cells.map(parseAmount);
    if (cells.length < 2 || parsed.some(p => !p)) return undefined;
    const first = parsed[0]!;
    if (parsed.some(p => p!.prefix !== first.prefix || p!.suffix !== first.suffix)) return undefined;
    const sum = parsed.reduce((s, p) => s + p!.value, 0);
    const decimals = Math.max(...cells.map(c => (c.match(/\.(\d+)/)?.[1].length ?? 0)));
    const body = Math.abs(sum).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    return `${sum < 0 ? '-' : ''}${first.prefix}${first.prefix.length > 1 ? ' ' : ''}${body}${first.suffix ? ` ${first.suffix}` : ''}`;
  });
  if (!totals.some(Boolean)) return undefined;
  const label = totals.findIndex(t => t === undefined);
  return totals.map((t, i) => (t !== undefined ? t : i === label ? 'Total (calculated)' : ''));
}
