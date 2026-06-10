import {
  it,
  after,
  assert,
  suite,
  now,
  parseErrorBackoff,
  handoff,
} from "../support/core-harness.js";

let db;

suite("Error Backoff (claude)", () => {
  it("parses retry-after from message", () => {
    const err = new Error("Rate limited. Please retry after 45 seconds");
    const result = parseErrorBackoff(err);
    assert.equal(result.backoffSec, 45);
    assert.equal(result.isRateLimit, true);
    assert.equal(result.source, "retry-after");
  });

  it("detects rate_limit_error", () => {
    const err = new Error("rate_limit_error: Too many requests");
    const result = parseErrorBackoff(err);
    assert.equal(result.backoffSec, 30);
    assert.equal(result.isRateLimit, true);
    assert.equal(result.source, "rate_limit");
  });

  it("detects overloaded_error", () => {
    const err = new Error("overloaded_error: Server busy");
    const result = parseErrorBackoff(err);
    assert.equal(result.backoffSec, 10);
    assert.equal(result.isRateLimit, true);
    assert.equal(result.source, "overloaded");
  });

  it("parses timezone-qualified usage-reset clock times", () => {
    const realNow = Date.now;
    Date.now = () => Date.parse("2026-04-10T11:00:00.000Z");
    try {
      const err = new Error("Claude usage limit reached. Try again at 11:15 AM UTC");
      const result = parseErrorBackoff(err);
      assert.equal(result.backoffSec, 15 * 60);
      assert.equal(result.isRateLimit, true);
      assert.equal(result.source, "usage_reset");
    } finally {
      Date.now = realNow;
    }
  });

  it("does not use host timezone for ambiguous usage-reset clock times", () => {
    const err = new Error("Claude usage limit reached. Try again at 11:15 AM");
    const result = parseErrorBackoff(err);
    assert.equal(result.backoffSec, 15 * 60);
    assert.equal(result.isRateLimit, true);
    assert.equal(result.source, "usage_limit");
  });

  it("uses a conservative cooldown for generic usage-limit errors", () => {
    const err = new Error("You have reached your Claude usage limit for now.");
    const result = parseErrorBackoff(err);
    assert.equal(result.backoffSec, 15 * 60);
    assert.equal(result.isRateLimit, true);
    assert.equal(result.source, "usage_limit");
  });

  it("parses hour-minute retry durations", () => {
    const err = new Error("Usage exhausted. Please try again in 1h 5m.");
    const result = parseErrorBackoff(err);
    assert.equal(result.backoffSec, (60 + 5) * 60);
    assert.equal(result.isRateLimit, true);
    assert.equal(result.source, "retry-after");
  });

  it("does not turn unrelated retry text plus reference durations into rate limits", () => {
    const err = new Error("model error: please retry. Reference 14h32m log");
    const result = parseErrorBackoff(err);
    assert.equal(result.backoffSec, 15);
    assert.equal(result.isRateLimit, false);
    assert.equal(result.source, "unknown");
  });

  it("detects 5xx server error", () => {
    const err = new Error("API Error: 502 Bad Gateway");
    const result = parseErrorBackoff(err);
    assert.equal(result.backoffSec, 10);
    assert.equal(result.isRateLimit, false);
    assert.equal(result.source, "server_error");
  });

  it("detects connection error", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:443");
    const result = parseErrorBackoff(err);
    assert.equal(result.backoffSec, 5);
    assert.equal(result.isRateLimit, false);
    assert.equal(result.source, "connection_error");
  });

  it("classifies failed Claude init invalid_client errors", () => {
    const err = new Error("claude exited 1\nFailed to initialize Claude agent\nOAuth error: invalid_client");
    const result = parseErrorBackoff(err);
    assert.equal(result.backoffSec, 0);
    assert.equal(result.isRateLimit, false);
    assert.equal(result.source, "invalid_client");
  });

  it("returns default for unknown error", () => {
    const err = new Error("Something went wrong");
    const result = parseErrorBackoff(err);
    assert.equal(result.backoffSec, 15);
    assert.equal(result.isRateLimit, false);
    assert.equal(result.source, "unknown");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST: File Request Parsing (handoff.js)
// ═════════════════════════════════════════════════════════════════════════════
