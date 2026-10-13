import { tool } from 'ai';
import { z } from 'zod';
import type { Ledger } from './harness';

/** What the model submits. Every figure must come from Zoho tool output. */
export const reportSchema = z.object({
  title: z.string().describe('Short report title'),
  summary: z.string().describe('2-4 sentence executive summary using only retrieved data'),
  metrics: z
    .array(
      z.object({
        label: z.string(),
        value: z.string().describe('Formatted value taken from, or directly computed from, tool data'),
        note: z.string().optional(),
      }),
    )
    .describe('Headline numbers (max ~6). Omit a metric rather than guess it.'),
  sections: z.array(
    z.object({
      heading: z.string(),
      body: z.string().optional().describe('Short narrative, markdown allowed'),
      table: z
        .object({
          columns: z.array(z.string()),
          rows: z.array(z.array(z.string())).describe('Each row has one cell per column'),
        })
        .optional(),
    }),
  ),
  insights: z.array(z.string()).describe('Findings and recommended actions that follow from the data'),
  caveats: z.array(z.string()).describe('Data gaps, truncation, assumptions. Empty if none.'),
});

/** What the UI renders: the model's report plus harness-owned provenance. */
export const finalReportSchema = reportSchema.extend({
  status: z.enum(['complete', 'no_data']).default('complete'),
  /** ISO timestamp set by the server when the report is delivered. */
  generatedAt: z.string().optional(),
  sources: z
    .array(z.object({ tool: z.string(), ok: z.number(), empty: z.number(), failed: z.number() }))
    .default([]),
});

export type Report = z.infer<typeof finalReportSchema>;

export const REPORT_TOOL = 'submit_report';

function noDataReport(ledger: Ledger): Report {
  return {
    status: 'no_data',
    generatedAt: new Date().toISOString(),
    title: 'No data available',
    summary:
      "I couldn't retrieve any data from Zoho for this request, so I can't produce a report. Nothing here is estimated.",
    metrics: [],
    sections: [],
    insights: [],
    caveats: ledger.caveats().length ? ledger.caveats() : ['No Zoho tool call completed for this request.'],
    sources: ledger.sources(),
  };
}

/**
 * Terminal tool. The harness, not the model, decides what ships:
 *  - no successful Zoho data  -> a "no data" report listing the real failures;
 *  - otherwise                -> the model's report, with sources and failure caveats attached by code.
 */
export function createSubmitReport(ledger: Ledger) {
  return tool({
    description:
      'Deliver the final structured report. Call exactly once, only after fetching data with the Zoho tools. Use only values returned by those tools; if data is missing, leave it out and say so in caveats.',
    inputSchema: reportSchema,
    execute: async (report): Promise<Report> => {
      if (!ledger.hasData) {
        if (ledger.calls.length === 0 && !ledger.forceFinal) {
          throw new Error(
            'No Zoho data has been fetched yet. Call the relevant Zoho tools first; reports may only contain data returned by them.',
          );
        }
        return noDataReport(ledger);
      }
      return {
        ...report,
        status: 'complete',
        generatedAt: new Date().toISOString(),
        caveats: [...new Set([...report.caveats, ...ledger.caveats()])],
        sources: ledger.sources(),
      };
    },
  });
}
