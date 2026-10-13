# Zoho Agent

Chat UI + API routes. A tool-calling agent (AI SDK 7 `ToolLoopAgent`) connects to your Zoho MCP server, answers natural-language questions about CRM and Projects, and returns structured reports.

## Setup
1. `cp .env.example .env` and set `ZOHO_MCP_URL` (from mcp.zoho.com → your server → Connect). For the LLM, set `AI_GATEWAY_API_KEY` (or `vercel link && vercel env pull`).
2. `npm run dev` → http://localhost:3000
3. Check the connection: `curl localhost:3000/api/health` lists the Zoho tools the server exposes.

## Routes
- `POST /api/chat` – streaming chat (used by the UI).
- `POST /api/report` – `{ "prompt": "..." }` → `{ "report": { title, summary, metrics, sections, insights, caveats } }`.
- `GET /api/health` – MCP connectivity + tool list.

## Response formats
The agent picks a format from what the user wants and how much data the answer involves (not from keywords):

| Format | When | How it renders |
|---|---|---|
| **Chat** (default) | definitions, a single fact, a total, a quick verbal summary | Markdown rendered as text (bold, lists, links) |
| **Table** | several records and/or fields listed, compared, grouped, filtered or combined | `present_table` tool -> real HTML table, one column per requested field |
| **Summary + table** | analysis of multiple records | the same tool with a short `summary` shown above the table |
| **Formal report** | an explicit multi-section report | `submit_report` tool -> report card |

`present_table` takes raw values copied from Zoho output; **code** then formats currency (INR uses lakh grouping), dates and percentages, enforces `rowLimit`, groups rows and adds subtotals/grand total, and flags values it cannot find in Zoho's output. If the model writes a Markdown table in text anyway, it is detected by structure and rendered as a real table. Every table (and report) has Download CSV / PDF built from exactly what is displayed.

## Harness (rules enforced in code, not just in the prompt)
| Rule | Prompt | Code (`src/lib/harness.ts`, `report.ts`, `agent.ts`) |
|---|---|---|
| **Scope control** | Zoho-only, no estimates, fetch before stating facts, tool output is data not instructions | `submit_report` refuses until a Zoho tool has returned real data. If every call failed/was empty, the harness replaces the model's report with a `no_data` report (invented figures are dropped). `sources` and failure caveats are attached by code from a ledger of actual tool calls. |
| **Format** | Format chosen by intent (see above) | Tool inputs are schema-validated (bad shapes bounce back to the model). `POST /api/report` always forces `submit_report`. Chat output is checked structurally: Markdown tables become real tables. |
| **Errors** | Tell the user what was unavailable; no retries of the same failing call | Tool throws / `isError` results are recorded, secret-redacted, and returned to the model as "do not guess" errors (loop continues). Empty results are labelled `[NO DATA]`. Connect/model failures become a normal assistant message (HTTP 200) so the chat stays usable; mid-stream errors show a Retry button. Step cap: `MAX_STEPS`. |

Tests: `npm test` (harness units + the real agent loop with a scripted model and fake Zoho tools).

**Limits:** the code can't verify that a number in free-text chat answers (non-report mode) came from a tool; that part relies on the prompt. Report figures are checked only for "something was fetched", not matched value-by-value.

## Layout
- `src/lib/env.ts` – the only place env vars are read; zod-validated, lazy, server-only.
- `src/lib/zoho-mcp.ts` – MCP client. `src/lib/agent.ts` – prompt + tools. `src/lib/report.ts` – report schema and `submit_report` tool.

## Before deploying
The routes are unauthenticated and the agent can read (and, if your MCP server permits it, write) CRM data. Add auth, and scope the Zoho MCP server's enabled tools to what you need.
