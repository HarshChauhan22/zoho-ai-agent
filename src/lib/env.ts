import { z } from 'zod';

const schema = z.object({
  ZOHO_MCP_URL: z.url({ error: 'ZOHO_MCP_URL must be the full Zoho MCP endpoint URL' }),
  ZOHO_MCP_API_KEY: z.string().min(1).optional(),
  ZOHO_ALLOW_WRITES: z.enum(['true', 'false']).default('false'),
  ZOHO_MCP_AUTH: z.enum(['oauth', 'none']).default('oauth'),
  ZOHO_MCP_TRANSPORT: z.enum(['http', 'sse']).default('http'),
  AGENT_MODEL: z.string().min(1).optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validated, server-only config. Read lazily so `next build` works without secrets. */
export function getEnv(): Env {
  if (cached) return cached;

  // Treat empty strings (e.g. blank lines in .env) as unset.
  const raw = Object.fromEntries(
    Object.keys(schema.shape).map(k => [k, process.env[k] || undefined]),
  );
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}\nSee .env.example.`);
  }
  return (cached = parsed.data);
}
