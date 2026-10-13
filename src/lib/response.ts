import { tool } from 'ai';
import { z } from 'zod';
import type { Ledger } from './harness';
import { buildDisplayTable, type DisplayTable } from './table';

/**
 * Structured "table response" (also used for "summary + table"). The model supplies columns and raw
 * values copied from Zoho; code does the formatting, grouping, subtotals, totals and row limit, so
 * the result is consistent and the model never does arithmetic.
 */

export const TABLE_TOOL = 'present_table';

export const tableInputSchema = z.object({
  title: z.string().describe('Short title, e.g. "Open deals by stage"'),
  summary: z
    .string()
    .optional()
    .describe('1-3 sentence insight shown ABOVE the table. Only for analysis requests; omit for a plain list.'),
  columns: z
    .array(
      z.object({
        label: z.string().describe('Column header, named from what the user asked for (e.g. "Deal Name")'),
        type: z
          .enum(['text', 'number', 'currency', 'date', 'percent'])
          .describe('How to format values. Ids, phone numbers, zip codes: text. Percent: plain number (25 = 25%).'),
        currency: z.string().optional().describe('ISO code for currency columns, e.g. INR or USD'),
      }),
    )
    .min(1),
  rows: z
    .array(z.array(z.string()))
    .describe('One array per record, one string per column, in column order. Copy values verbatim from Zoho output.'),
  groupBy: z.string().optional().describe('Label of a column to group rows by (adds per-group subtotals)'),
  totals: z.boolean().optional().describe('Set false to suppress the grand total row'),
  rowLimit: z.number().int().positive().optional().describe('If the user asked for N rows, N'),
  notes: z.array(z.string()).optional().describe('Data gaps or assumptions'),
});

export type TableInput = z.infer<typeof tableInputSchema>;

export const tableResultSchema = z.object({
  status: z.enum(['ok', 'no_data']),
  title: z.string(),
  summary: z.string().optional(),
  message: z.string().optional(),
  columns: z.array(z.object({ label: z.string(), align: z.enum(['left', 'right']) })),
  rows: z.array(z.object({ kind: z.enum(['data', 'subtotal', 'total']), cells: z.array(z.string()) })),
  notes: z.array(z.string()),
  sources: z.array(z.object({ tool: z.string(), ok: z.number(), empty: z.number(), failed: z.number() })),
  generatedAt: z.string(),
});

export type TableResult = z.infer<typeof tableResultSchema>;

/** Counts cells that never appear in what Zoho returned (a guard against invented values). */
export function ungroundedCells(rows: string[][], ledger: Ledger): { checked: number; missing: number } {
  let checked = 0;
  let missing = 0;
  for (const row of rows) {
    for (const cell of row) {
      if (cell.trim().length < 2) continue;
      checked++;
      if (!ledger.hasValue(cell)) missing++;
    }
  }
  return { checked, missing };
}

const empty = (ledger: Ledger, title: string, message: string): TableResult => ({
  status: 'no_data',
  title,
  message,
  columns: [],
  rows: [],
  notes: ledger.caveats(),
  sources: ledger.sources(),
  generatedAt: new Date().toISOString(),
});

export function createPresentTable(ledger: Ledger) {
  return tool({
    description:
      'Show results as a real table (optionally with a short summary above it). Use when the user wants multiple records or multiple fields listed, compared, grouped, filtered or combined. Call only after fetching data with the Zoho tools; copy values verbatim from their output. Do not repeat the table in text afterwards.',
    inputSchema: tableInputSchema,
    execute: async (input): Promise<TableResult> => {
      if (!ledger.hasData) {
        if (ledger.calls.length === 0) {
          throw new Error('No Zoho data has been fetched yet. Call the relevant Zoho tools first; tables may only contain data they returned.');
        }
        return empty(ledger, input.title, "I couldn't retrieve data from Zoho for this request, so there is no table to show. Nothing is estimated.");
      }
      if (input.rows.length === 0) {
        return empty(ledger, input.title, 'Zoho returned no matching records for this request.');
      }

      const built = buildDisplayTable({
        columns: input.columns,
        rows: input.rows,
        groupBy: input.groupBy,
        totals: input.totals,
        rowLimit: input.rowLimit,
      });

      const shownRaw = input.rowLimit ? input.rows.slice(0, input.rowLimit) : input.rows;
      const { checked, missing } = ungroundedCells(shownRaw, ledger);
      const notes = [
        ...(input.notes ?? []),
        ...built.notes,
        ...(missing
          ? [`${missing} of ${checked} values could not be matched to Zoho's output. Please verify them before relying on this table.`]
          : []),
        ...ledger.caveats(),
      ];

      return {
        status: 'ok',
        title: input.title,
        summary: input.summary?.trim() || undefined,
        columns: built.table.columns,
        rows: built.table.rows,
        notes: [...new Set(notes)],
        sources: ledger.sources(),
        generatedAt: new Date().toISOString(),
      };
    },
  });
}

export type { DisplayTable };
