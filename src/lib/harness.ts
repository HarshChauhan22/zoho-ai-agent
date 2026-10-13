import { asSchema, createUIMessageStream, createUIMessageStreamResponse, type ToolSet } from 'ai';
import { NoToolsError, NotConnectedError, ZohoToolError } from './errors';
import { toNumber } from './table';

/* ------------------------------------------------------------------ */
/* Secret redaction: errors reach both the model and the browser.      */
/* ------------------------------------------------------------------ */

export function redact(text: string): string {
  let out = text;
  const secrets = [process.env.ZOHO_MCP_URL, process.env.ZOHO_MCP_API_KEY, process.env.AI_GATEWAY_API_KEY];
  try {
    if (process.env.ZOHO_MCP_URL) {
      const u = new URL(process.env.ZOHO_MCP_URL);
      u.searchParams.forEach(v => secrets.push(v));
      // Zoho also embeds the key as a path segment: /mcp/<key>/message
      u.pathname.split('/').filter(seg => seg.length >= 16).forEach(seg => secrets.push(seg));
    }
  } catch {}
  for (const s of secrets) if (s && s.length > 6) out = out.split(s).join('[redacted]');
  return out
    .replace(/(\/mcp\/)[A-Za-z0-9_-]{16,}/g, '$1[redacted]')
    .replace(/([?&](?:key|api_?key|token|access_token)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]');
}

export function friendlyError(err: unknown): string {
  // Our own typed errors carry a message that is already safe and precise.
  if (err instanceof NotConnectedError || err instanceof NoToolsError) return err.message;
  if (err instanceof ZohoToolError) return redact(err.userMessage);

  const msg = redact(err instanceof Error ? err.message : String(err));
  if (msg.startsWith('Invalid environment')) return `The agent isn't configured yet.\n${msg}`;
  // Third-party errors arrive as plain Errors; classify them conservatively.
  if (/generativelanguage|ai gateway|rate.?limit|\b429\b|quota|api key/i.test(msg)) {
    return `The AI model request failed. Try again in a moment. (${msg.slice(0, 200)})`;
  }
  if (/zohomcp|\bMCP\b|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|\b40[13]\b|timed? ?out/i.test(msg)) {
    return `I couldn't get data from the Zoho MCP server, so I can't answer right now. Check ZOHO_MCP_URL / credentials and try again. (${msg.slice(0, 200)})`;
  }
  return `Something went wrong: ${msg.slice(0, 300)}`;
}

/** Returns an ordinary assistant message instead of an HTTP error, so the chat keeps working. */
export function assistantTextResponse(text: string): Response {
  const id = 'harness-msg';
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute({ writer }) {
        writer.write({ type: 'start' });
        writer.write({ type: 'text-start', id });
        writer.write({ type: 'text-delta', id, delta: text });
        writer.write({ type: 'text-end', id });
        writer.write({ type: 'finish' });
      },
    }),
  });
}

/* ------------------------------------------------------------------ */
/* Ledger: ground truth of what Zoho tools actually returned.          */
/* ------------------------------------------------------------------ */

export type CallStatus = 'ok' | 'empty' | 'error';
export type Source = { tool: string; ok: number; empty: number; failed: number };

export class Ledger {
  calls: { tool: string; status: CallStatus; detail?: string }[] = [];
  /** Set on the last allowed step: the report tool must now conclude, with or without data. */
  forceFinal = false;
  /** Tools whose result was cut to MAX_RESULT_CHARS; figures built from them may be incomplete. */
  truncated = new Set<string>();
  private outputs: string[] = [];
  private outputChars = 0;
  private haystack?: { text: string; numbers: Set<string> };

  /** Remember what Zoho actually returned, so displayed values can be checked against it. */
  addOutput(text: string) {
    if (this.outputChars > 3_000_000) return;
    this.outputs.push(text);
    this.outputChars += text.length;
    this.haystack = undefined;
  }

  /** True if `value` appears in Zoho's output (numbers compared by value, text case-insensitively). */
  hasValue(value: string): boolean {
    this.haystack ??= (() => {
      const text = this.outputs.join('\n').toLowerCase().replace(/\s+/g, ' ');
      const numbers = new Set((text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(n => String(Number(n.replace(/,/g, '')))));
      return { text, numbers };
    })();
    const v = value.trim().toLowerCase().replace(/\s+/g, ' ');
    const n = toNumber(value);
    if (n !== undefined && /^[^a-z]*\d[\d,.\s]*[^a-z\d]*$/i.test(v)) return this.haystack.numbers.has(String(Math.abs(n)));
    return this.haystack.text.includes(v);
  }

  record(tool: string, status: CallStatus, detail?: string) {
    this.calls.push({ tool, status, detail });
  }

  get hasData() {
    return this.calls.some(c => c.status === 'ok');
  }

  sources(): Source[] {
    const map = new Map<string, Source>();
    for (const c of this.calls) {
      const s = map.get(c.tool) ?? { tool: c.tool, ok: 0, empty: 0, failed: 0 };
      if (c.status === 'ok') s.ok++;
      else if (c.status === 'empty') s.empty++;
      else s.failed++;
      map.set(c.tool, s);
    }
    return [...map.values()];
  }

  /** Deterministic caveats derived from real tool outcomes (never from model claims). */
  caveats(): string[] {
    const truncation = [...this.truncated].map(
      t => `"${t}" returned more data than fits; the result was truncated, so totals may be incomplete.`,
    );
    return [...truncation, ...this.sources().flatMap(s => {
      const out: string[] = [];
      if (s.failed) {
        const detail = this.calls.find(c => c.tool === s.tool && c.status === 'error')?.detail;
        out.push(`"${s.tool}" failed ${s.failed}×${detail ? `: ${detail.slice(0, 160)}` : ''}`);
      }
      if (s.empty) out.push(`"${s.tool}" returned no records ${s.empty}×.`);
      return out;
    })];
  }
}

/* ------------------------------------------------------------------ */
/* Classifying MCP tool results.                                       */
/* ------------------------------------------------------------------ */

type McpLike = {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
};

function resultText(r: McpLike | string | undefined): string {
  if (typeof r === 'string') return r;
  return (r?.content ?? [])
    .filter(c => c?.type === 'text')
    .map(c => c.text ?? '')
    .join('\n')
    .trim();
}

function isEmptyPayload(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') {
    const t = v.trim();
    return !t || /^(\[\s*\]|\{\s*\}|null|no (records?|data|results?|items?) (found|available)\.?)$/i.test(t);
  }
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') {
    const values = Object.values(v as object);
    if (values.length === 0) return true;
    // Zoho-style envelopes: { data: [], info: {...} } — every array present is empty.
    const arrays = values.filter(Array.isArray) as unknown[][];
    return arrays.length > 0 && arrays.every(a => a.length === 0);
  }
  return false;
}

/** Zoho (and others) report failures in the body without setting MCP's isError flag. */
function envelopeFailure(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const top = payload as Record<string, unknown>;
  const inner =
    top.data && typeof top.data === 'object' && !Array.isArray(top.data) ? (top.data as Record<string, unknown>) : top;
  const status = String(top.status ?? inner.status ?? '').toLowerCase();
  const code = String(inner.code ?? top.code ?? '');
  const message = String(inner.message ?? top.message ?? '');
  const failedStatus = status === 'failure' || status === 'error';
  const failedCode = /(ERROR|INVALID|MISMATCH|FAILED|DENIED|UNAUTHORI[SZ]ED|FORBIDDEN|EXCEEDED|NOT_FOUND)/.test(code) && status !== 'success';
  return failedStatus || failedCode ? redact(`${code || 'error'}${message ? `: ${message}` : ''}`) : undefined;
}

export function classifyResult(result: unknown): { status: CallStatus; detail?: string } {
  const r = result as McpLike | string | undefined;
  const text = resultText(r);
  if (typeof r === 'object' && r?.isError) {
    return { status: 'error', detail: redact(text || 'Tool reported an error') };
  }
  if (typeof r === 'object' && r?.content?.some(c => c.type !== 'text')) return { status: 'ok' };

  let payload: unknown = typeof r === 'object' ? r?.structuredContent : undefined;
  if (payload === undefined) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  const failure = envelopeFailure(payload);
  if (failure) return { status: 'error', detail: failure };
  return isEmptyPayload(payload) ? { status: 'empty' } : { status: 'ok' };
}

/** Keeps one oversized result from flooding the model's context (and your token quota). */
export const MAX_RESULT_CHARS = 30_000;

function truncateResult(result: unknown, tool: string, ledger: Ledger): unknown {
  const r = result as McpLike | undefined;
  if (typeof r !== 'object' || !r || resultText(r).length <= MAX_RESULT_CHARS) return result;
  ledger.truncated.add(tool);
  const text = resultText(r).slice(0, MAX_RESULT_CHARS);
  return {
    content: [{ type: 'text', text: `${text}\n[TRUNCATED: result exceeded ${MAX_RESULT_CHARS} characters. Say that figures may be incomplete.]` }],
  };
}

/**
 * Wraps every Zoho tool so that:
 *  - failures are redacted, recorded, and surfaced to the model as "do not guess" errors
 *    (the SDK keeps the loop alive on thrown tool errors);
 *  - empty results are explicitly labelled so the model cannot fill the gap with estimates.
 */
export function guardTools(tools: ToolSet, ledger: Ledger): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => {
      const execute = t.execute as ((i: unknown, o: unknown) => Promise<unknown>) | undefined;
      if (!execute) return [name, t];

      return [
        name,
        {
          ...t,
          execute: async (input: unknown, options: unknown) => {
            let result: unknown;
            try {
              result = await execute(input, options);
            } catch (err) {
              const msg = redact(err instanceof Error ? err.message : String(err));
              ledger.record(name, 'error', msg);
              throw new ZohoToolError(name, msg);
            }

            const { status, detail } = classifyResult(result);
            ledger.record(name, status, detail);
            if (status === 'ok') {
              const r = result as McpLike;
              ledger.addOutput(`${resultText(r)}\n${r?.structuredContent ? JSON.stringify(r.structuredContent) : ''}`);
            }

            if (status === 'error') throw new ZohoToolError(name, detail ?? 'unknown error');
            if (status === 'empty') {
              return {
                content: [
                  {
                    type: 'text',
                    text: `[NO DATA] "${name}" returned no records for this query. Report this as empty. Do not estimate or invent values.`,
                  },
                ],
                harnessStatus: 'empty',
              };
            }
            return truncateResult(result, name, ledger);
          },
        },
      ];
    }),
  ) as ToolSet;
}

/* ------------------------------------------------------------------ */
/* Tool selection: read-only by default, and nothing a model can't take. */
/* ------------------------------------------------------------------ */

// Classify a tool by the verbs in its name ("ZohoCRM_getRecords", "Zoho_Projects_list_tasks").
// Any write verb wins; otherwise it must contain a read verb. Unknown names are dropped.
const READ_VERBS = new Set(['get', 'list', 'show', 'search', 'fetch', 'read', 'find', 'query', 'count', 'run']);
const WRITE_VERBS = new Set([
  'create', 'update', 'patch', 'post', 'put', 'delete', 'remove', 'add', 'set', 'send', 'upload', 'move',
  'merge', 'convert', 'approve', 'reject', 'clone', 'restore', 'assign', 'cancel', 'submit', 'insert',
  'upsert', 'write', 'edit', 'modify', 'reorder', 'transfer', 'share', 'invite', 'enable', 'disable',
  'activate', 'deactivate', 'reset', 'revoke', 'mark', 'unmark', 'archive', 'publish', 'sync', 'trigger',
]);

function nameWords(name: string): string[] {
  return name
    .split('_')
    .flatMap(seg => seg.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map(w => w.toLowerCase());
}

export function isReadOnlyTool(name: string, annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }): boolean {
  if (annotations?.destructiveHint === true) return false;
  const words = nameWords(name);
  if (words.some(w => WRITE_VERBS.has(w))) return false;
  return annotations?.readOnlyHint === true || words.some(w => READ_VERBS.has(w));
}
/** Gemini (and others) reject or choke on enormous tool schemas; one bad tool fails every request. */
export const MAX_SCHEMA_CHARS = 40_000;

export type DroppedTool = { name: string; reason: 'write-tool' | 'schema-too-large' };

export function selectTools(
  tools: ToolSet,
  opts: { allowWrites?: boolean; maxSchemaChars?: number } = {},
): { tools: ToolSet; dropped: DroppedTool[] } {
  const max = opts.maxSchemaChars ?? MAX_SCHEMA_CHARS;
  const kept: ToolSet = {};
  const dropped: DroppedTool[] = [];
  for (const [name, t] of Object.entries(tools)) {
    const annotations = (t as { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }).annotations;
    if (!opts.allowWrites && !isReadOnlyTool(name, annotations)) {
      dropped.push({ name, reason: 'write-tool' });
      continue;
    }
    let size = 0;
    try {
      size = JSON.stringify(asSchema(t.inputSchema).jsonSchema).length;
    } catch {}
    if (size > max) {
      dropped.push({ name, reason: 'schema-too-large' });
      continue;
    }
    kept[name] = t;
  }
  return { tools: kept, dropped };
}
