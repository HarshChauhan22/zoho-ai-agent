import { createAgentUIStreamResponse, type UIMessage } from 'ai';
import { createZohoAgent } from '@/lib/agent';
import { assistantTextResponse, friendlyError } from '@/lib/harness';

export const maxDuration = 300;

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const messages: UIMessage[] | undefined = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: 'Body must be { messages: UIMessage[] }' }, { status: 400 });
  }

  let close: (() => Promise<void>) | undefined;
  try {
    const zoho = await createZohoAgent();
    close = zoho.close;
    const onAbort = () => void zoho.close();
    req.signal.addEventListener('abort', onAbort, { once: true });
    // Backstop: never leak the MCP connection if the stream dies before the agent finishes.
    const backstop = setTimeout(onAbort, maxDuration * 1000);
    backstop.unref();
    const release = () => {
      clearTimeout(backstop);
      req.signal.removeEventListener('abort', onAbort);
    };
    zoho.onClosed(release);

    return await createAgentUIStreamResponse({
      agent: zoho.agent,
      uiMessages: messages,
      abortSignal: req.signal,
      // Also invoked for individual tool failures, so it must not close the MCP client:
      // the loop continues after a failed tool. The client closes when the agent ends.
      onError: err => {
        console.error('[api/chat stream]', err);
        return friendlyError(err);
      },
    });
  } catch (err) {
    await close?.();
    console.error('[api/chat]', err);
    // Reply as the assistant (HTTP 200) so the conversation stays usable.
    return assistantTextResponse(friendlyError(err));
  }
}
