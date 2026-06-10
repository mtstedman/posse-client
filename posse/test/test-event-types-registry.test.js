import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { EVENT_TYPES } from "../lib/catalog/event.js";
import {
  validateEventType,
  warnOnceForInvalidEventType,
  KNOWN_EVENT_NAMESPACES,
  __resetEventTypeWarningsForTests,
} from "../lib/domains/observability/functions/event-types.js";

describe("event-types registry", () => {
  beforeEach(() => {
    __resetEventTypeWarningsForTests();
  });

  it("accepts well-known dotted event types", () => {
    for (const type of [
      "job.created",
      "job.dependency_rewired",
      "research.fanout_child_timed_out",
      "wi.escalation",
      "atlas.proxy_init_failed",
      "git.merge",
      "scheduler.boot",
    ]) {
      const result = validateEventType(type);
      assert.equal(result.valid, true, `expected ${type} to be valid: ${result.reason || ""}`);
    }
  });

  it("accepts legacy bare types from the explicit allowlist", () => {
    for (const type of [
      "session_acquired",
      "session_advanced",
      "session_invalidated",
      "session_lane_locked",
      "session_lease_expired",
      "skill_inferred",
      "skill_skipped_disabled",
      "skill_skipped_unknown",
    ]) {
      assert.equal(validateEventType(type).valid, true, `expected legacy ${type} to be valid`);
    }
  });

  it("rejects bare types not on the legacy allowlist", () => {
    const result = validateEventType("new_event_without_namespace");
    assert.equal(result.valid, false);
    assert.equal(result.kind, "unknown-bare");
  });

  it("rejects dotted types with unknown namespace", () => {
    const result = validateEventType("doesnotexist.foo");
    assert.equal(result.valid, false);
    assert.equal(result.kind, "unknown-namespace");
    assert.equal(result.namespace, "doesnotexist");
  });

  it("rejects malformed segments", () => {
    for (const bad of ["job.HasUppercase", "job.has-dash", "job.123starts_with_digit", "job..double_dot"]) {
      const result = validateEventType(bad);
      assert.equal(result.valid, false, `${bad} should be invalid`);
      assert.equal(result.kind, "malformed");
    }
  });

  it("rejects non-strings and empty strings", () => {
    assert.equal(validateEventType(null).kind, "non-string");
    assert.equal(validateEventType(undefined).kind, "non-string");
    assert.equal(validateEventType(123).kind, "non-string");
    assert.equal(validateEventType("").kind, "empty");
  });

  it("warnOnceForInvalidEventType emits at most one warning per type per process", () => {
    const originalWarn = console.warn;
    const lines = [];
    console.warn = (msg) => lines.push(msg);
    try {
      warnOnceForInvalidEventType("doesnotexist.foo");
      warnOnceForInvalidEventType("doesnotexist.foo");
      warnOnceForInvalidEventType("doesnotexist.foo");
      assert.equal(lines.length, 1, "expected exactly one warning for repeated invalid type");
      assert.match(lines[0], /unknown namespace/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("warnOnceForInvalidEventType stays silent for valid types", () => {
    const originalWarn = console.warn;
    const lines = [];
    console.warn = (msg) => lines.push(msg);
    try {
      warnOnceForInvalidEventType("job.created");
      warnOnceForInvalidEventType("research.fanout_child_timed_out");
      assert.equal(lines.length, 0);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("accepts every catalogued event type", () => {
    for (const type of Object.values(EVENT_TYPES)) {
      const result = validateEventType(type);
      assert.equal(result.valid, true, `expected catalogued ${type} to be valid: ${result.reason || ""}`);
    }
  });

  it("keeps logEvent call sites on EVENT_TYPES constants", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const libDir = path.join(root, "lib");
    const failures = [];

    function visit(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
        const lines = fs.readFileSync(fullPath, "utf8").split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          const assignment = line.match(/event_type:\s*(.*)$/);
          if (!assignment) continue;
          if (/EVENT_TYPES/.test(assignment[1])) continue;
          if (/["']/.test(assignment[1])) {
            failures.push(`${path.relative(root, fullPath)}:${index + 1}: ${line.trim()}`);
          }
        }
      }
    }

    visit(libDir);
    assert.deepEqual(failures, []);
  });

  it("KNOWN_EVENT_NAMESPACES covers the namespaces observed in the codebase survey", () => {
    // Sanity: ensure the survey-derived namespaces are present.
    for (const ns of [
      "job", "research", "wi", "atlas", "git", "scheduler", "cleanup",
      "preflight", "planner", "worktree", "artifacts",
    ]) {
      assert.equal(KNOWN_EVENT_NAMESPACES.has(ns), true, `expected ${ns} in registry`);
    }
  });
});
