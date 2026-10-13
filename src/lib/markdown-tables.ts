import type { DisplayTable } from './table';
import { parseAmount } from './export/model';

/**
 * Safety net: if the model writes a Markdown table in plain text instead of using the structured
 * table tool, find it by its *structure* (header row + delimiter row + body rows) and hand back
 * real columns/rows so the UI renders an actual table. Text around it is returned untouched.
 */

export type Segment = { type: 'text'; text: string } | { type: 'table'; table: DisplayTable };

const DELIMITER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
    else if (s[i] === '|') { cells.push(cur); cur = ''; }
    else cur += s[i];
  }
  cells.push(cur);
  return cells.map(c => c.trim());
}

/** Strip inline Markdown decoration so cells read (and export) as plain values. */
const clean = (c: string) =>
  c.replace(/<br\s*\/?>/gi, ' ').replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]+)`/g, '$1');

export function splitMarkdownTables(text: string): Segment[] {
  const lines = text.split('\n');
  const segments: Segment[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length) segments.push({ type: 'text', text: buffer.join('\n') });
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const head = lines[i];
    const delim = lines[i + 1];
    if (head?.includes('|') && delim && DELIMITER.test(delim) && delim.includes('|')) {
      const headers = splitRow(head);
      const delimCells = splitRow(delim);
      if (headers.length === delimCells.length && headers.length >= 1) {
        const body: string[][] = [];
        let j = i + 2;
        while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
          const cells = splitRow(lines[j]);
          body.push(Array.from({ length: headers.length }, (_, k) => clean(cells[k] ?? '')));
          j++;
        }
        flush();
        const numericCol = headers.map((_, k) => {
          const cells = body.map(r => r[k]).filter(Boolean);
          return cells.length > 0 && cells.every(c => parseAmount(c) !== undefined);
        });
        segments.push({
          type: 'table',
          table: {
            columns: headers.map((h, k) => ({
              label: clean(h),
              align: /:\s*$/.test(delimCells[k]) || (numericCol[k] && !/^\s*:/.test(delimCells[k])) ? 'right' : 'left',
            })),
            rows: body.map(cells => ({ kind: 'data' as const, cells })),
          },
        });
        i = j - 1;
        continue;
      }
    }
    buffer.push(head);
  }
  flush();
  return segments.filter(s => s.type === 'table' || s.text.trim());
}
