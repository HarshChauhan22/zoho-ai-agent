/** Typed errors so callers branch with `instanceof`, not by matching message text. */

export class NotConnectedError extends Error {
  constructor(connectUrl: string) {
    super(`Zoho isn't connected yet. Open ${connectUrl} to sign in, then try again.`);
    this.name = 'NotConnectedError';
  }
}

export class NoToolsError extends Error {
  constructor() {
    super(
      'The Zoho MCP server is connected but exposes no tools I can use (read-only tools only, unless ZOHO_ALLOW_WRITES=true). In the Zoho MCP console, open your server and add tools (e.g. Zoho CRM: search/get records; Zoho Projects: list projects/tasks), then try again.',
    );
    this.name = 'NoToolsError';
  }
}

/**
 * A Zoho tool call failed. `message` is what the model sees (it includes instructions);
 * `userMessage` is what people see.
 */
export class ZohoToolError extends Error {
  readonly userMessage: string;
  constructor(tool: string, detail: string) {
    const userMessage = `Zoho tool "${tool}" failed: ${detail}`.slice(0, 500);
    super(`${userMessage}. Do not guess this data. Tell the user it is unavailable.`);
    this.name = 'ZohoToolError';
    this.userMessage = userMessage;
  }
}
