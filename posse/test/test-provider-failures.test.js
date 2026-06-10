// test/test-provider-failures.test.js
//
// Provider failure injection: parseErrorBackoff + getRateLimitState
// shape and classification across rate-limit, retry-after, server, and
// connection error scenarios for each provider module.
//
// Each provider's parseErrorBackoff is a pure function over an Error-like
// input. We exercise the major branches without spawning subprocesses or
// hitting any network — production failure-mode coverage that the rest of
// the suite skips.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const PROVIDERS = ["claude", "codex", "openai", "grok"];
const PROVIDER_MODULES = Object.freeze({
  claude: () => import("../lib/domains/providers/functions/claude.js"),
  codex: () => import("../lib/domains/providers/functions/codex.js"),
  openai: () => import("../lib/domains/providers/functions/openai.js"),
  grok: () => import("../lib/domains/providers/functions/grok.js"),
});

async function loadProvider(name) {
  const load = PROVIDER_MODULES[name];
  assert.equal(typeof load, "function", `unknown provider fixture: ${name}`);
  return await load();
}

function err({ message = "", status = null, headers = null } = {}) {
  const e = new Error(message);
  if (status != null) e.status = status;
  if (headers) e.headers = headers;
  return e;
}

describe("provider failure injection", () => {
  describe("parseErrorBackoff has a stable shape", () => {
    for (const name of PROVIDERS) {
      it(`${name}: returns { backoffSec, isRateLimit, source } for an unknown error`, async () => {
        const mod = await loadProvider(name);
        const result = mod.parseErrorBackoff(err({ message: "wat" }));
        assert.equal(result.backoffSec, 15);
        assert.equal(typeof result.isRateLimit, "boolean");
        assert.equal(typeof result.source, "string");
        assert.ok(result.source.length > 0);
      });
    }
  });

  describe("classifies rate limits", () => {
    for (const name of PROVIDERS) {
      it(`${name}: a "rate limit" message returns isRateLimit=true with positive backoff`, async () => {
        const mod = await loadProvider(name);
        const result = mod.parseErrorBackoff(err({ message: "429 Too Many Requests: rate limit hit" }));
        assert.equal(result.isRateLimit, true, `${name} should mark rate-limit as such`);
        assert.ok(result.backoffSec > 0, `${name} should pick a positive backoff`);
      });
    }

    for (const name of ["openai", "grok"]) {
      it(`${name}: status=429 with a Retry-After header honors the header`, async () => {
        const mod = await loadProvider(name);
        const result = mod.parseErrorBackoff(err({
          message: "rate limit",
          status: 429,
          headers: { "retry-after": "42" },
        }));
        assert.equal(result.isRateLimit, true);
        assert.equal(result.backoffSec, 42);
        assert.equal(result.source, "retry-after");
      });
    }

    for (const name of ["claude", "codex"]) {
      it(`${name}: an explicit "retry after Ns" message picks N`, async () => {
        const mod = await loadProvider(name);
        const result = mod.parseErrorBackoff(err({ message: "please retry after 12s" }));
        assert.equal(result.isRateLimit, true);
        assert.equal(result.backoffSec, 12);
        assert.equal(result.source, "retry-after");
      });
    }
  });

  describe("classifies server errors as retryable but non-rate-limit", () => {
    for (const name of PROVIDERS) {
      it(`${name}: "internal server error" message is not flagged as rate-limit`, async () => {
        const mod = await loadProvider(name);
        const result = mod.parseErrorBackoff(err({ message: "Internal server error from upstream" }));
        assert.equal(result.isRateLimit, false);
        assert.ok(result.backoffSec > 0);
      });
    }
  });

  describe("classifies connection errors", () => {
    for (const name of PROVIDERS) {
      it(`${name}: ECONNRESET picks the connection-error source`, async () => {
        const mod = await loadProvider(name);
        const result = mod.parseErrorBackoff(err({ message: "fetch failed: ECONNRESET" }));
        assert.equal(result.isRateLimit, false);
        assert.ok(result.backoffSec >= 0);
        assert.match(result.source, /connection/i,
          `${name} should classify ECONNRESET as a connection error; got source=${result.source}`);
      });
    }
  });

  describe("getRateLimitState shape", () => {
    for (const name of PROVIDERS) {
      it(`${name}: returns { blocked, retryInSec, reason }`, async () => {
        const mod = await loadProvider(name);
        const state = mod.getRateLimitState();
        assert.equal(typeof state.blocked, "boolean");
        assert.equal(typeof state.retryInSec, "number");
        assert.ok(state.retryInSec >= 0);
        assert.equal(typeof state.reason, "string");
      });
    }
  });

  describe("classifies shared quota and overload errors consistently", () => {
    for (const name of PROVIDERS) {
      it(`${name}: usage exhaustion uses the shared 15 minute cooldown`, async () => {
        const mod = await loadProvider(name);
        const result = mod.parseErrorBackoff(err({ message: "usage limit reached; quota exceeded" }));
        assert.equal(result.isRateLimit, true);
        assert.equal(result.backoffSec, 15 * 60);
        assert.equal(result.source, "usage_limit");
      });

      it(`${name}: overloaded/529 errors use the shared overload classification`, async () => {
        const mod = await loadProvider(name);
        const result = mod.parseErrorBackoff(err({ message: "API Error: 529 overloaded_error", status: 529 }));
        assert.equal(result.isRateLimit, true);
        assert.equal(result.backoffSec, 10);
        assert.equal(result.source, "overloaded");
      });
    }
  });

  describe("rate-limit state propagation", () => {
    for (const name of PROVIDERS) {
      it(`${name}: parseErrorBackoff is inspect-only; getProviderBackoff trips runtime state`, async () => {
        const mod = await loadProvider(name);
        const { providerRuntimeState } = await import("../lib/domains/providers/classes/runtime-state-singleton.js");
        const { getProviderBackoff } = await import("../lib/domains/providers/functions/provider.js");
        const resetRateLimit = () => {
          if (name === "claude" || name === "codex") providerRuntimeState.resetRateLimit(name);
          else mod.tripRateLimit(0);
        };

        resetRateLimit();
        try {
          const parsed = mod.parseErrorBackoff(err({ message: "rate limit hit, retry after 60s" }));
          assert.equal(parsed.isRateLimit, true);
          assert.equal(mod.getRateLimitState().blocked, false);

          const operational = getProviderBackoff(name, err({ message: "rate limit hit, retry after 60s" }));
          assert.equal(operational.isRateLimit, true);
          const after = mod.getRateLimitState();
          assert.equal(after.blocked, true);
          assert.ok(after.retryInSec > 0);
        } finally {
          resetRateLimit();
        }
      });
    }
  });

  describe("backoff is bounded", () => {
    // No matter what an attacker-controlled message contains, the parser must
    // not return absurdly large backoff seconds. Claude allows 12h for
    // usage_reset windows ("come back tomorrow"); openai/grok/codex stay
    // tighter. 24h is the floor across all providers.
    for (const name of PROVIDERS) {
      it(`${name}: huge "retry after" values cap below 24 hours`, async () => {
        const mod = await loadProvider(name);
        const result = mod.parseErrorBackoff(err({ message: "retry after 999999s" }));
        assert.ok(result.backoffSec <= 24 * 3600,
          `${name} should cap backoff under 24 hours; got ${result.backoffSec}`);
      });
    }

    it("shared circuit breaker preserves long Retry-After values within the Claude-style bound", async () => {
      const { createCircuitBreaker, MAX_RETRY_AFTER_SECONDS } = await import("../lib/domains/providers/functions/helpers/api-resilience.js");
      const breaker = createCircuitBreaker();
      const before = Date.now();
      breaker.trip(3600);
      assert.ok(
        breaker.getResetAt() - before >= (3600 - 1) * 1000,
        "one-hour Retry-After should no longer be capped to 120s",
      );

      const capped = createCircuitBreaker();
      const cappedBefore = Date.now();
      capped.trip(999999);
      assert.ok(
        capped.getResetAt() - cappedBefore <= (MAX_RETRY_AFTER_SECONDS * 1000) + 1000,
        "absurd Retry-After values should still be bounded",
      );
    });

    for (const name of ["codex", "openai", "grok"]) {
      it(`${name}: long Retry-After values are not capped to 120 seconds`, async () => {
        const mod = await loadProvider(name);
        const result = name === "codex"
          ? mod.parseErrorBackoff(err({ message: "please retry after 3600s" }))
          : mod.parseErrorBackoff(err({
            message: "rate limit",
            status: 429,
            headers: { "retry-after": "3600" },
          }));
        assert.equal(result.isRateLimit, true);
        assert.equal(result.backoffSec, 3600);
        assert.equal(result.source, "retry-after");
      });
    }
  });

  describe("shared retry wrapper", () => {
    it("retries transient HTTP 500 errors now that SDK retries are disabled", async () => {
      const { createCircuitBreaker, createRetryWrapper } = await import("../lib/domains/providers/functions/helpers/api-resilience.js");
      const withRetry = createRetryWrapper({ breaker: createCircuitBreaker() });
      let attempts = 0;
      const result = await withRetry(async () => {
        attempts++;
        if (attempts === 1) {
          const error = new Error("Internal server error");
          error.status = 500;
          throw error;
        }
        return "ok";
      }, { maxAttempts: 2, baseDelayMs: 1 });

      assert.equal(result, "ok");
      assert.equal(attempts, 2);
    });

    it("emits an operator-visible warning for long Retry-After circuit trips", async () => {
      const { createCircuitBreaker, createRetryWrapper } = await import("../lib/domains/providers/functions/helpers/api-resilience.js");
      const emitted = [];
      const withRetry = createRetryWrapper({ breaker: createCircuitBreaker() });

      await assert.rejects(
        withRetry(async () => {
          const error = new Error("rate limit");
          error.status = 429;
          error.headers = { "retry-after": "3600" };
          throw error;
        }, {
          maxAttempts: 1,
          emit: (line) => emitted.push(String(line)),
        }),
        /rate limit/,
      );

      assert.ok(emitted.some((line) => /3600s/.test(line) && /circuit breaker/i.test(line)));
    });

    it("reads Retry-After from fetch-style Headers in the retry wrapper", async () => {
      const { createCircuitBreaker, createRetryWrapper } = await import("../lib/domains/providers/functions/helpers/api-resilience.js");
      const emitted = [];
      const withRetry = createRetryWrapper({ breaker: createCircuitBreaker() });

      await assert.rejects(
        withRetry(async () => {
          const error = new Error("rate limit");
          error.status = 429;
          error.headers = { get: (name) => name.toLowerCase() === "retry-after" ? "3600" : null };
          throw error;
        }, {
          maxAttempts: 1,
          emit: (line) => emitted.push(String(line)),
        }),
        /rate limit/,
      );

      assert.ok(emitted.some((line) => /3600s/.test(line) && /circuit breaker/i.test(line)));
    });

    it("does not retry rate-limit errors inside the retry wrapper", async () => {
      const { createCircuitBreaker, createRetryWrapper } = await import("../lib/domains/providers/functions/helpers/api-resilience.js");
      const withRetry = createRetryWrapper({ breaker: createCircuitBreaker() });
      let attempts = 0;

      await assert.rejects(
        withRetry(async () => {
          attempts++;
          const error = new Error("rate limit");
          error.status = 429;
          throw error;
        }, { maxAttempts: 3, baseDelayMs: 1 }),
        /rate limit/,
      );

      assert.equal(attempts, 1);
    });

    it("keeps OpenAI/Grok SDK retries disabled so withRetry is the visible retry layer", async () => {
      const openai = await import("../lib/domains/providers/functions/openai.js");
      const grok = await import("../lib/domains/providers/functions/grok.js");
      const { createCircuitBreaker, createRetryWrapper } = await import("../lib/domains/providers/functions/helpers/api-resilience.js");

      assert.equal(openai.__testBuildOpenAiClientOptions().maxRetries, 0);
      assert.equal(grok.__testBuildGrokClientOptions().maxRetries, 0);

      const withRetry = createRetryWrapper({ breaker: createCircuitBreaker() });
      let attempts = 0;
      const result = await withRetry(async () => {
        attempts++;
        if (attempts < 3) {
          const error = new Error("Internal server error");
          error.status = 500;
          throw error;
        }
        return "ok";
      }, { maxAttempts: 3, baseDelayMs: 1 });

      assert.equal(result, "ok");
      assert.equal(attempts, 3);
    });
  });
});
