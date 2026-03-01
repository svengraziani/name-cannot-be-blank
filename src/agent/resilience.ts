/**
 * Retry & Circuit Breaker for Anthropic API calls.
 *
 * - Exponential backoff with jitter on transient errors (429, 500, 502, 503, 529)
 * - Circuit breaker: after N consecutive failures the circuit opens and
 *   calls fail fast for a cooldown period before attempting a half-open probe.
 * - Emits events for observability (retry, circuit state changes).
 */

import { EventEmitter } from 'events';
import { config } from '../config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryConfig {
  /** Maximum number of retry attempts (default 3). */
  maxRetries: number;
  /** Base delay in ms for exponential backoff (default 1000). */
  baseDelayMs: number;
  /** Maximum delay cap in ms (default 30000). */
  maxDelayMs: number;
  /** Jitter factor 0–1 added to delay (default 0.2). */
  jitterFactor: number;
}

export interface CircuitBreakerConfig {
  /** Consecutive failures to trip the circuit (default 5). */
  failureThreshold: number;
  /** Cooldown in ms before half-open probe (default 60000). */
  resetTimeoutMs: number;
  /** Successes in half-open state to close the circuit (default 1). */
  halfOpenSuccessThreshold: number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface ResilienceStats {
  circuitState: CircuitState;
  consecutiveFailures: number;
  totalRetries: number;
  totalFailures: number;
  totalSuccesses: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const resilienceEvents = new EventEmitter();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** HTTP status codes considered transient / retryable. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529]);

function isRetryableError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    // Anthropic SDK errors expose a `status` property.
    const status = (err as { status?: number }).status;
    if (typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status)) {
      return true;
    }

    // Also retry on generic network errors.
    const message = (err as { message?: string }).message || '';
    if (
      message.includes('ECONNRESET') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ECONNREFUSED') ||
      message.includes('socket hang up') ||
      message.includes('fetch failed')
    ) {
      return true;
    }
  }
  return false;
}

/** Return the Retry-After header value in ms (if present), else undefined. */
function getRetryAfterMs(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const headers = (err as { headers?: Record<string, string> }).headers;
    if (headers) {
      const retryAfter = headers['retry-after'];
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (!Number.isNaN(seconds)) return seconds * 1000;
      }
    }
  }
  return undefined;
}

function computeDelay(attempt: number, cfg: RetryConfig, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) {
    // Respect server-requested delay, but add a small jitter.
    return retryAfterMs + Math.random() * cfg.jitterFactor * retryAfterMs;
  }
  const exponential = cfg.baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, cfg.maxDelayMs);
  const jitter = capped * cfg.jitterFactor * Math.random();
  return capped + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private totalRetries = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private openedAt: number | null = null;

  private readonly retryCfg: RetryConfig;
  private readonly cbCfg: CircuitBreakerConfig;

  constructor(retryCfg?: Partial<RetryConfig>, cbCfg?: Partial<CircuitBreakerConfig>) {
    this.retryCfg = {
      maxRetries: retryCfg?.maxRetries ?? config.retry.maxRetries,
      baseDelayMs: retryCfg?.baseDelayMs ?? config.retry.baseDelayMs,
      maxDelayMs: retryCfg?.maxDelayMs ?? config.retry.maxDelayMs,
      jitterFactor: retryCfg?.jitterFactor ?? config.retry.jitterFactor,
    };
    this.cbCfg = {
      failureThreshold: cbCfg?.failureThreshold ?? config.circuitBreaker.failureThreshold,
      resetTimeoutMs: cbCfg?.resetTimeoutMs ?? config.circuitBreaker.resetTimeoutMs,
      halfOpenSuccessThreshold:
        cbCfg?.halfOpenSuccessThreshold ?? config.circuitBreaker.halfOpenSuccessThreshold,
    };
  }

  // ---- public API ----

  /** Execute `fn` with retry + circuit breaker protection. */
  async execute<T>(fn: () => Promise<T>, label = 'api-call'): Promise<T> {
    this.assertCircuitAllows(label);

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retryCfg.maxRetries; attempt++) {
      try {
        const result = await fn();
        this.onSuccess();
        return result;
      } catch (err) {
        lastError = err;

        if (!isRetryableError(err)) {
          // Non-transient error — don't retry, don't count against circuit.
          throw err;
        }

        this.onFailure(err);

        if (attempt < this.retryCfg.maxRetries && this.state !== 'open') {
          const retryAfterMs = getRetryAfterMs(err);
          const delay = computeDelay(attempt, this.retryCfg, retryAfterMs);
          this.totalRetries++;

          const status = (err as { status?: number }).status;
          console.warn(
            `[resilience] ${label}: attempt ${attempt + 1}/${this.retryCfg.maxRetries + 1} failed (status=${status ?? 'N/A'}), retrying in ${Math.round(delay)}ms`,
          );
          resilienceEvents.emit('retry', {
            label,
            attempt: attempt + 1,
            maxRetries: this.retryCfg.maxRetries,
            delayMs: Math.round(delay),
            status,
          });

          await sleep(delay);

          // Re-check circuit state before next attempt
          this.assertCircuitAllows(label);
        }
      }
    }

    // All retries exhausted
    throw lastError;
  }

  /** Current stats (for health endpoints / logging). */
  getStats(): ResilienceStats {
    return {
      circuitState: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      totalRetries: this.totalRetries,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
    };
  }

  /** Reset all counters and close the circuit. */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.openedAt = null;
    resilienceEvents.emit('circuit:reset', { state: 'closed' });
  }

  // ---- internal ----

  private getState(): CircuitState {
    if (this.state === 'open') {
      const elapsed = Date.now() - (this.openedAt ?? 0);
      if (elapsed >= this.cbCfg.resetTimeoutMs) {
        this.state = 'half-open';
        console.log('[resilience] Circuit breaker transitioning to half-open');
        resilienceEvents.emit('circuit:state', { state: 'half-open' });
      }
    }
    return this.state;
  }

  private assertCircuitAllows(label: string): void {
    const current = this.getState();
    if (current === 'open') {
      const remainingMs = this.cbCfg.resetTimeoutMs - (Date.now() - (this.openedAt ?? 0));
      console.warn(
        `[resilience] ${label}: circuit OPEN — failing fast (cooldown ${Math.round(remainingMs / 1000)}s remaining)`,
      );
      resilienceEvents.emit('circuit:rejected', { label, remainingMs });
      throw new CircuitOpenError(
        `Circuit breaker is OPEN after ${this.consecutiveFailures} consecutive failures. ` +
          `Retry in ${Math.round(remainingMs / 1000)}s.`,
      );
    }
  }

  private onSuccess(): void {
    this.totalSuccesses++;
    this.lastSuccessTime = Date.now();

    if (this.state === 'half-open') {
      console.log('[resilience] Circuit breaker closing after successful half-open probe');
      this.state = 'closed';
      this.consecutiveFailures = 0;
      this.openedAt = null;
      resilienceEvents.emit('circuit:state', { state: 'closed' });
    } else {
      this.consecutiveFailures = 0;
    }
  }

  private onFailure(err: unknown): void {
    this.consecutiveFailures++;
    this.totalFailures++;
    this.lastFailureTime = Date.now();

    if (this.consecutiveFailures >= this.cbCfg.failureThreshold && this.state !== 'open') {
      this.state = 'open';
      this.openedAt = Date.now();
      const status = (err as { status?: number }).status;
      console.error(
        `[resilience] Circuit breaker OPEN after ${this.consecutiveFailures} consecutive failures (last status=${status ?? 'N/A'})`,
      );
      resilienceEvents.emit('circuit:state', {
        state: 'open',
        failures: this.consecutiveFailures,
        resetTimeoutMs: this.cbCfg.resetTimeoutMs,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

// ---------------------------------------------------------------------------
// Singleton for the main Anthropic API circuit breaker
// ---------------------------------------------------------------------------

let defaultBreaker: CircuitBreaker | null = null;

export function getDefaultCircuitBreaker(): CircuitBreaker {
  if (!defaultBreaker) {
    defaultBreaker = new CircuitBreaker();
  }
  return defaultBreaker;
}
