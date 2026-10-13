import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { getEnv } from './env';

const DEFAULT_GEMINI = 'gemini-2.5-flash';
const DEFAULT_GATEWAY = 'anthropic/claude-sonnet-5.5';

/**
 * Picks the LLM from the environment:
 *  - AGENT_MODEL "google/<id>" or "gemini-*"  -> Gemini directly (needs a Google key)
 *  - AGENT_MODEL "<provider>/<model>"         -> Vercel AI Gateway (needs AI_GATEWAY_API_KEY or Vercel OIDC)
 *  - nothing usable for the gateway but a Google key is set -> Gemini default
 */
export function resolveModel(): { model: LanguageModel; label: string } {
  const env = getEnv();
  const googleKey = env.GOOGLE_GENERATIVE_AI_API_KEY ?? env.GEMINI_API_KEY;
  const requested = env.AGENT_MODEL;
  const gatewayUsable = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL);

  const wantsGoogle = requested?.startsWith('google/') || requested?.startsWith('gemini-');
  const useGoogle = wantsGoogle || (!gatewayUsable && googleKey);

  if (useGoogle) {
    if (!googleKey) {
      throw new Error('Invalid environment configuration:\n  - GOOGLE_GENERATIVE_AI_API_KEY: required for Gemini models');
    }
    const id = wantsGoogle ? requested!.replace(/^google\//, '') : DEFAULT_GEMINI;
    return { model: createGoogleGenerativeAI({ apiKey: googleKey })(id), label: `google:${id}` };
  }

  if (!gatewayUsable) {
    throw new Error(
      'Invalid environment configuration:\n  - set GOOGLE_GENERATIVE_AI_API_KEY (Gemini) or AI_GATEWAY_API_KEY (Vercel AI Gateway)',
    );
  }
  const id = requested ?? DEFAULT_GATEWAY;
  return { model: id, label: `gateway:${id}` };
}
