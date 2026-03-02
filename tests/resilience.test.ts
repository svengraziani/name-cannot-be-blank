/**
 * Retry & Circuit Breaker Tests
 *
 * Uses Node built-in assert + test runner to verify:
 * - Retry with exponential backoff on transient errors
 * - Non-retryable errors propagate immediately
 * - Circuit breaker opens after threshold failures
 * - Circuit breaker half-open probe and recovery
 * - Stats tracking
 *
 * Run: npx tsx tests/resilience.test.ts
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

// Ensure config env vars are set before import
process.env.DB_PATH = '/tmp/resilience-test.db';
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

import { CircuitBreaker, CircuitOpenError } from '../src/agent/resilience';

// Helper: create an error that looks like an Anthropic SDK 429
function apiError(status: number, message = 'API error'): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

// Helper: create a error with headers including Retry-After
function apiErrorWithRetryAfter(
  status: number,
  retryAfterSec: number,
): Error & { status: number; headers: Record<string, string> } {
  const err = new Error('Rate limited') as Error & {
    status: number;
    headers: Record<string, string>;
  };
  err.status = status;
  err.headers = { 'retry-after': String(retryAfterSec) };
  return err;
}

// ============================================================
// Retry Tests
// ============================================================

describe('Retry: successful call', () => {
  test('returns result on first try', async () => {
    const breaker = new CircuitBreaker({ maxRetries: 3 }, { failureThreshold: 10 });
    let calls = 0;
    const result = await breaker.execute(async () => {
      calls++;
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });
});

describe('Retry: transient errors with recovery', () => {
  test('retries on 429 and eventually succeeds', async () => {
    const breaker = new CircuitBreaker(
      { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 },
      { failureThreshold: 10 },
    );
    let calls = 0;
    const result = await breaker.execute(async () => {
      calls++;
      if (calls < 3) throw apiError(429, 'Rate limited');
      return 'recovered';
    });
    assert.equal(result, 'recovered');
    assert.equal(calls, 3);
  });

  test('retries on 500 and eventually succeeds', async () => {
    const breaker = new CircuitBreaker(
      { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 },
      { failureThreshold: 10 },
    );
    let calls = 0;
    const result = await breaker.execute(async () => {
      calls++;
      if (calls < 2) throw apiError(500, 'Internal server error');
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
  });

  test('retries on 529 (overloaded)', async () => {
    const breaker = new CircuitBreaker(
      { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 },
      { failureThreshold: 10 },
    );
    let calls = 0;
    const result = await breaker.execute(async () => {
      calls++;
      if (calls < 2) throw apiError(529, 'Overloaded');
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
  });
});

describe('Retry: exhausted retries', () => {
  test('throws after all retries exhausted', async () => {
    const breaker = new CircuitBreaker(
      { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 },
      { failureThreshold: 10 },
    );

    await assert.rejects(
      () =>
        breaker.execute(async () => {
          throw apiError(500, 'Always fails');
        }),
      (err: Error) => {
        assert.equal(err.message, 'Always fails');
        return true;
      },
    );
  });
});

describe('Retry: non-retryable errors', () => {
  test('does not retry on 400 (bad request)', async () => {
    const breaker = new CircuitBreaker(
      { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 },
      { failureThreshold: 10 },
    );
    let calls = 0;

    await assert.rejects(
      () =>
        breaker.execute(async () => {
          calls++;
          throw apiError(400, 'Bad request');
        }),
      (err: Error) => {
        assert.equal(err.message, 'Bad request');
        return true;
      },
    );
    assert.equal(calls, 1, 'should only call once for non-retryable error');
  });

  test('does not retry on 401 (unauthorized)', async () => {
    const breaker = new CircuitBreaker(
      { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 },
      { failureThreshold: 10 },
    );
    let calls = 0;

    await assert.rejects(
      () =>
        breaker.execute(async () => {
          calls++;
          throw apiError(401, 'Unauthorized');
        }),
      (err: Error) => {
        assert.equal(err.message, 'Unauthorized');
        return true;
      },
    );
    assert.equal(calls, 1);
  });

  test('does not retry on generic Error without status', async () => {
    const breaker = new CircuitBreaker(
      { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 },
      { failureThreshold: 10 },
    );
    let calls = 0;

    await assert.rejects(
      () =>
        breaker.execute(async () => {
          calls++;
          throw new Error('Some other error');
        }),
      (err: Error) => {
        assert.equal(err.message, 'Some other error');
        return true;
      },
    );
    assert.equal(calls, 1);
  });
});

describe('Retry: network errors are retryable', () => {
  test('retries on ECONNRESET', async () => {
    const breaker = new CircuitBreaker(
      { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 },
      { failureThreshold: 10 },
    );
    let calls = 0;
    const result = await breaker.execute(async () => {
      calls++;
      if (calls < 2) throw new Error('read ECONNRESET');
      return 'recovered';
    });
    assert.equal(result, 'recovered');
    assert.equal(calls, 2);
  });

  test('retries on fetch failed', async () => {
    const breaker = new CircuitBreaker(
      { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 },
      { failureThreshold: 10 },
    );
    let calls = 0;
    const result = await breaker.execute(async () => {
      calls++;
      if (calls < 2) throw new Error('fetch failed');
      return 'recovered';
    });
    assert.equal(result, 'recovered');
    assert.equal(calls, 2);
  });
});

// ============================================================
// Circuit Breaker Tests
// ============================================================

describe('Circuit Breaker: opens after threshold', () => {
  test('trips after N consecutive failures', async () => {
    const breaker = new CircuitBreaker(
      { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 },
      { failureThreshold: 3, resetTimeoutMs: 60000 },
    );

    // Cause 3 consecutive failures
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => breaker.execute(async () => { throw apiError(500); }));
    }

    // Now the circuit should be open — next call fails fast
    await assert.rejects(
      () => breaker.execute(async () => 'should not run'),
      (err: Error) => {
        assert.ok(err instanceof CircuitOpenError);
        assert.ok(err.message.includes('OPEN'));
        return true;
      },
    );

    const stats = breaker.getStats();
    assert.equal(stats.circuitState, 'open');
    assert.equal(stats.consecutiveFailures, 3);
  });
});

describe('Circuit Breaker: half-open recovery', () => {
  test('transitions to half-open after cooldown and closes on success', async () => {
    const breaker = new CircuitBreaker(
      { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 },
      { failureThreshold: 2, resetTimeoutMs: 100, halfOpenSuccessThreshold: 1 },
    );

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      await assert.rejects(() => breaker.execute(async () => { throw apiError(500); }));
    }

    assert.equal(breaker.getStats().circuitState, 'open');

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 150));

    // The circuit should now be half-open and allow a probe
    const result = await breaker.execute(async () => 'recovered');
    assert.equal(result, 'recovered');
    assert.equal(breaker.getStats().circuitState, 'closed');
    assert.equal(breaker.getStats().consecutiveFailures, 0);
  });

  test('re-opens if half-open probe fails', async () => {
    const breaker = new CircuitBreaker(
      { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 },
      { failureThreshold: 2, resetTimeoutMs: 100 },
    );

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      await assert.rejects(() => breaker.execute(async () => { throw apiError(500); }));
    }

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 150));

    // Half-open probe fails — circuit reopens
    await assert.rejects(() => breaker.execute(async () => { throw apiError(500); }));
    assert.equal(breaker.getStats().circuitState, 'open');
  });
});

describe('Circuit Breaker: reset', () => {
  test('manual reset closes the circuit', async () => {
    const breaker = new CircuitBreaker(
      { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 },
      { failureThreshold: 2, resetTimeoutMs: 60000 },
    );

    // Trip the circuit
    for (let i = 0; i < 2; i++) {
      await assert.rejects(() => breaker.execute(async () => { throw apiError(500); }));
    }

    assert.equal(breaker.getStats().circuitState, 'open');

    breaker.reset();

    assert.equal(breaker.getStats().circuitState, 'closed');
    assert.equal(breaker.getStats().consecutiveFailures, 0);

    // Should work again
    const result = await breaker.execute(async () => 'ok');
    assert.equal(result, 'ok');
  });
});

describe('Circuit Breaker: stats tracking', () => {
  test('tracks successes and failures', async () => {
    const breaker = new CircuitBreaker(
      { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 },
      { failureThreshold: 10 },
    );

    await breaker.execute(async () => 'ok');
    await breaker.execute(async () => 'ok');
    await assert.rejects(() => breaker.execute(async () => { throw apiError(500); }));
    await breaker.execute(async () => 'ok');

    const stats = breaker.getStats();
    assert.equal(stats.totalSuccesses, 3);
    assert.equal(stats.totalFailures, 1);
    assert.equal(stats.consecutiveFailures, 0); // reset after success
    assert.ok(stats.lastSuccessTime);
    assert.ok(stats.lastFailureTime);
  });
});

describe('Circuit Breaker: success resets consecutive failures', () => {
  test('consecutive failures reset on success', async () => {
    const breaker = new CircuitBreaker(
      { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 },
      { failureThreshold: 5 },
    );

    // 3 failures
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => breaker.execute(async () => { throw apiError(500); }));
    }
    assert.equal(breaker.getStats().consecutiveFailures, 3);

    // 1 success resets the counter
    await breaker.execute(async () => 'ok');
    assert.equal(breaker.getStats().consecutiveFailures, 0);

    // 3 more failures don't trip the circuit (threshold is 5)
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => breaker.execute(async () => { throw apiError(500); }));
    }
    assert.equal(breaker.getStats().circuitState, 'closed');
  });
});

describe('Retry-After header', () => {
  test('respects Retry-After header from 429 response', async () => {
    const breaker = new CircuitBreaker(
      { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 50, jitterFactor: 0 },
      { failureThreshold: 10 },
    );
    let calls = 0;
    const start = Date.now();
    const result = await breaker.execute(async () => {
      calls++;
      if (calls < 2) throw apiErrorWithRetryAfter(429, 0.1); // 100ms
      return 'ok';
    });
    const elapsed = Date.now() - start;
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
    // Should have waited at least ~100ms (Retry-After: 0.1s)
    assert.ok(elapsed >= 80, `Expected at least 80ms delay, got ${elapsed}ms`);
  });
});

console.log('\n All Resilience tests completed!\n');
