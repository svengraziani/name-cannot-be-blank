/**
 * Fallback Chains – Multi-provider failover for zero downtime.
 *
 * Claude down? → Automatically try GPT-4o. That down too? → Local Ollama model.
 * Definable per Agent Group as a priority list.
 *
 * Supports:
 * - Anthropic (Claude) – native, via @anthropic-ai/sdk
 * - OpenAI (GPT-4o, etc.) – via OpenAI-compatible API
 * - Ollama (local models) – via OpenAI-compatible API on localhost
 *
 * Each provider is tried in order. If one fails (network error, 5xx, rate limit),
 * the next provider in the chain is attempted. The conversation context is
 * adapted for each provider's API format.
 */

export type FallbackProviderType = 'anthropic' | 'openai' | 'ollama';

export interface FallbackProvider {
  type: FallbackProviderType;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Max retries on this provider before moving to next */
  maxRetries: number;
  /** Timeout per request in ms */
  timeoutMs: number;
  /** Label for logging */
  label: string;
}

export interface FallbackChainConfig {
  enabled: boolean;
  providers: FallbackProvider[];
}

export const DEFAULT_FALLBACK_CHAIN: FallbackChainConfig = {
  enabled: false,
  providers: [],
};

export interface FallbackCallResult {
  content: string;
  provider: FallbackProvider;
  inputTokens: number;
  outputTokens: number;
  attempts: FallbackAttempt[];
}

export interface FallbackAttempt {
  provider: FallbackProvider;
  success: boolean;
  error?: string;
  durationMs: number;
}

interface SimpleMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Call an OpenAI-compatible API (works for OpenAI, Ollama, and any compatible endpoint).
 */
async function callOpenAICompatible(
  provider: FallbackProvider,
  systemPrompt: string,
  messages: SimpleMessage[],
  maxTokens: number,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const baseUrl = provider.baseUrl || 'https://api.openai.com/v1';
  const url = `${baseUrl}/chat/completions`;

  const body = {
    model: provider.model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system' as const, content: systemPrompt },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (provider.apiKey) {
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), provider.timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(`${provider.label} API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    return {
      content: data.choices?.[0]?.message?.content || '(no response)',
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Execute a fallback chain: try each provider in order until one succeeds.
 *
 * The Anthropic provider is handled externally (the caller should pass its result
 * or error). This function handles the non-Anthropic fallback providers.
 */
export async function executeFallbackChain(
  chain: FallbackChainConfig,
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  primaryError: Error,
): Promise<FallbackCallResult> {
  const simpleMessages: SimpleMessage[] = messages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));

  const attempts: FallbackAttempt[] = [
    {
      provider: { type: 'anthropic', model: 'primary', maxRetries: 1, timeoutMs: 0, label: 'Primary (Anthropic)' },
      success: false,
      error: primaryError.message,
      durationMs: 0,
    },
  ];

  // Filter to non-anthropic providers (anthropic already failed)
  const fallbackProviders = chain.providers.filter((p) => p.type !== 'anthropic');

  for (const provider of fallbackProviders) {
    for (let retry = 0; retry < provider.maxRetries; retry++) {
      const start = Date.now();
      try {
        console.log(
          `[fallback] Trying ${provider.label} (${provider.model})${retry > 0 ? ` retry ${retry}` : ''}...`,
        );

        const result = await callOpenAICompatible(provider, systemPrompt, simpleMessages, maxTokens);
        const duration = Date.now() - start;

        attempts.push({ provider, success: true, durationMs: duration });

        console.log(`[fallback] ${provider.label} succeeded in ${duration}ms`);

        return {
          content: result.content,
          provider,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          attempts,
        };
      } catch (err) {
        const duration = Date.now() - start;
        const errorMsg = err instanceof Error ? err.message : String(err);
        attempts.push({ provider, success: false, error: errorMsg, durationMs: duration });
        console.warn(`[fallback] ${provider.label} failed: ${errorMsg}`);
      }
    }
  }

  // All providers failed
  const errorSummary = attempts
    .map((a) => `${a.provider.label}: ${a.error || 'unknown'}`)
    .join('; ');
  throw new Error(`All fallback providers failed: ${errorSummary}`);
}

/**
 * Check if an error is a transient/retryable error (network, 5xx, rate limit).
 */
export function isRetryableError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('500') ||
    msg.includes('529') || // Anthropic overloaded
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('overloaded')
  );
}
