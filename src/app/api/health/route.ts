import { friendlyError } from '@/lib/harness';
import { resolveModel } from '@/lib/model';
import { connectZohoMcp, loadZohoTools } from '@/lib/zoho-mcp';

/** Connectivity check: confirms env is valid and lists the tools the agent can use. */
export async function GET() {
  try {
    const mcp = await connectZohoMcp();
    try {
      const { tools, dropped, total } = await loadZohoTools(mcp);
      const count = Object.keys(tools).length;
      return Response.json({
        ok: count > 0,
        warning:
          count === 0
            ? 'Connected, but no usable tools. Add CRM/Projects tools in the Zoho MCP console.'
            : undefined,
        model: resolveModel().label,
        toolCount: count,
        serverToolCount: total,
        tools: Object.keys(tools),
        dropped,
      });
    } finally {
      await mcp.close().catch(() => {});
    }
  } catch (err) {
    return Response.json({ ok: false, error: friendlyError(err) }, { status: 503 });
  }
}
