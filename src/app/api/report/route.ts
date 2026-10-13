import { z } from 'zod';
import { createZohoAgent } from '@/lib/agent';
import { friendlyError } from '@/lib/harness';
import { REPORT_TOOL, finalReportSchema } from '@/lib/report';

export const maxDuration = 300;

const body = z.object({ prompt: z.string().min(1).max(4000) });

/** Non-chat entry point: POST { prompt } -> { report }. Always a schema-valid report, or { error }. */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'Body must be { "prompt": string }' }, { status: 400 });
  }

  let close: (() => Promise<void>) | undefined;
  try {
    const zoho = await createZohoAgent({ reportMode: true });
    close = zoho.close;
    const result = await zoho.agent.generate({
      prompt: parsed.data.prompt,
      abortSignal: req.signal,
    });

    for (const step of [...result.steps].reverse()) {
      const call = step.toolResults.find(r => r.toolName === REPORT_TOOL);
      if (call) return Response.json({ report: finalReportSchema.parse(call.output) });
    }
    return Response.json({ error: 'The agent did not produce a report.', text: result.text }, { status: 502 });
  } catch (err) {
    console.error('[api/report]', err);
    return Response.json({ error: friendlyError(err) }, { status: 502 });
  } finally {
    await close?.();
  }
}
