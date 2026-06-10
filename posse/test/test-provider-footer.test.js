import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { closeDb, getDb } from "../lib/shared/storage/functions/index.js";
import {
  _buildQueueProviderUsageLines,
  getCurrentRunProviderUsage,
} from "../lib/domains/ui/functions/display/helpers/provider-usage.js";
import { brandGauge } from "../lib/domains/ui/functions/display/helpers/brand.js";
import { displayColumnWidth } from "../lib/shared/format/functions/ansi.js";
import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";

function plain(lines) {
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

async function withTempDb(fn) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-provider-footer-"));
  closeDb();
  setRuntimePathOverridesForTests({ dbPath: path.join(runtimeDir, "orchestrator.db") });
  try {
    return await fn(getDb());
  } finally {
    closeDb();
    setRuntimePathOverridesForTests(null);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

describe("provider usage footer", () => {
  it("uses green for calm budget gauges instead of the provider accent color", () => {
    const colors = {
      reset: "</>",
      dim: "<dim>",
      bold: "<bold>",
      cyan: "<cyan>",
      green: "<green>",
      yellow: "<yellow>",
      orange: "<orange>",
      red: "<red>",
    };

    const calm = brandGauge(8, { width: 10, colors });
    assert.equal(calm.tierColor, colors.green);
    assert.match(calm.bar, /<green>█/);
    assert.doesNotMatch(calm.bar, /<orange>/);
    assert.equal(calm.pctText, "<green><bold>  8%</>");

    const warning = brandGauge(90, { width: 10, colors });
    assert.equal(warning.tierColor, colors.orange);
    assert.match(warning.bar, /<orange>█/);
    assert.equal(warning.glyph, "");
  });

  it("hides provider account windows when the provider was not used in the current run", () => {
    const lines = _buildQueueProviderUsageLines(80, 9, [
      {
        provider: "openai",
        source: "posse-agent-calls",
        windows: [
          { key: "session", label: "Session (5h)", usedTokens: 0, limitTokens: null, utilizationPct: 37 },
          { key: "week", label: "Week (7d)", usedTokens: 0, limitTokens: 100000, remainingTokens: 100000 },
        ],
      },
    ]);

    assert.deepEqual(lines, []);
  });

  it("hides account snapshots until the provider has been used in the current run", () => {
    const lines = _buildQueueProviderUsageLines(80, 9, [
      {
        provider: "openai",
        source: "account-snapshot",
        localUsedTokens: 0,
        windows: [
          { key: "session", label: "Session (5h)", usedTokens: 5000, limitTokens: 10000, observedPct: 50 },
        ],
      },
    ]);

    assert.deepEqual(lines, []);
  });

  it("does not promote account snapshots solely because the provider is active", () => {
    const lines = _buildQueueProviderUsageLines(80, 9, [
      {
        provider: "openai",
        source: "account-snapshot",
        localUsedTokens: 0,
        windows: [
          { key: "session", label: "Session (5h)", usedTokens: 5000, limitTokens: 10000, observedPct: 50 },
        ],
      },
    ], {
      activeProviders: new Set(["openai"]),
    });

    assert.deepEqual(lines, []);
  });

  it("renders active Claude usage summaries before completed call tokens exist", () => {
    const output = plain(_buildQueueProviderUsageLines(80, 9, [
      {
        provider: "claude",
        source: "anthropic-oauth-usage-api",
        windows: [
          { key: "session", usedTokens: 85, limitTokens: 100 },
          { key: "week", utilizationPct: 95 },
        ],
      },
    ], {
      activeProviders: new Set(["claude"]),
      currentRunProviderUsage: [],
    }));

    assert.match(output, /╶━━ CLAUDE ━━/);
    assert.match(output, /0 tok/);
    // 85% is yellow (60-89%); color carries pressure without an alert glyph.
    assert.match(output, /\[S\] ▕█████████████████░░░▏\s+85%/);
    // 95% is red (>=95%); color carries pressure without an alert glyph.
    assert.match(output, /\[W\] ▕███████████████████░▏\s+95%/);
    assert.doesNotMatch(output, /[⚠✷]/);
  });

  it("renders non-Claude current-run provider usage as tokens only", () => {
    const output = plain(_buildQueueProviderUsageLines(80, 9, [
      {
        provider: "openai",
        source: "posse-agent-calls",
        localUsedTokens: 1500,
        windows: [
          { key: "session", label: "Session (5h)", usedTokens: 1500, limitTokens: 10000, remainingTokens: 8500 },
          { key: "week", label: "Week (7d)", usedTokens: 1500, limitTokens: 20000, remainingTokens: 18500 },
        ],
      },
    ], {
      currentRunProviderUsage: [{ provider: "openai", usedTokens: 1500 }],
    }));

    assert.match(output, /╶━━ OPENAI ━━/);
    assert.match(output, /1\.5K tok/);
    assert.doesNotMatch(output, /%/);
    assert.doesNotMatch(output, /\[S\]/);
    assert.doesNotMatch(output, /\[W\]/);
  });

  it("renders Codex current-run usage without requiring a provider usage module", () => {
    const output = plain(_buildQueueProviderUsageLines(80, 9, [], {
      currentRunProviderUsage: [{ provider: "codex", usedTokens: 23235 }],
    }));

    assert.match(output, /╶━━ CODEX ━━/);
    assert.match(output, /23\.2K tok/);
  });

  it("renders Codex status windows as session and weekly budget bars", () => {
    const nowMs = Date.parse("2026-05-18T09:00:00.000Z");
    const output = plain(_buildQueueProviderUsageLines(80, 9, [
      {
        provider: "codex",
        source: "codex-cli-status",
        windows: [
          { key: "session", utilizationPct: 30, resetAt: "2026-05-18T13:15:00.000Z" },
          { key: "week", utilizationPct: 20, resetAt: "2026-05-20T10:00:00.000Z" },
        ],
      },
    ], {
      nowMs,
      currentRunProviderUsage: [{ provider: "codex", usedTokens: 23235 }],
    }));

    assert.match(output, /╶━━ CODEX ━━/);
    assert.match(output, /\[S\] ▕██████░░░░░░░░░░░░░░▏\s+30% 4h 15m/);
    assert.match(output, /\[W\] ▕████░░░░░░░░░░░░░░░░▏\s+20% 2d 1h/);
  });

  it("renders Claude current-run usage with session and weekly budget bars", () => {
    const nowMs = Date.parse("2026-05-18T09:00:00.000Z");
    const output = plain(_buildQueueProviderUsageLines(80, 9, [
      {
        provider: "claude",
        source: "anthropic-oauth-usage-api",
        windows: [
          { key: "session", usedTokens: 85, limitTokens: 100, resetAt: "2026-05-18T10:00:00.000Z" },
          { key: "week", utilizationPct: 95, resetAt: "2026-05-19T09:00:00.000Z" },
        ],
      },
    ], {
      nowMs,
      currentRunProviderUsage: [{ provider: "claude", usedTokens: 12414 }],
    }));

    assert.match(output, /╶━━ CLAUDE ━━/);
    assert.match(output, /12\.4K tok/);
    // 85% is yellow (60-89%); color carries pressure without an alert glyph.
    assert.match(output, /\[S\] ▕█████████████████░░░▏\s+85% 1h/);
    // 95% is red (>=95%); color carries pressure without an alert glyph.
    assert.match(output, /\[W\] ▕███████████████████░▏\s+95% 1d/);
    assert.doesNotMatch(output, /[⚠✷]/);
  });

  it("keeps budget gauge rows aligned without alert glyphs", () => {
    const output = plain(_buildQueueProviderUsageLines(80, 9, [
      {
        provider: "claude",
        source: "anthropic-oauth-usage-api",
        windows: [
          { key: "session", utilizationPct: 25 },
          { key: "week", utilizationPct: 89 },
        ],
      },
    ], {
      currentRunProviderUsage: [{ provider: "claude", usedTokens: 1000 }],
    }));

    assert.match(output, /\[S\] ▕█████░░░░░░░░░░░░░░░▏\s+25%/);
    assert.match(output, /\[W\] ▕██████████████████░░▏\s+89%/);
    assert.doesNotMatch(output, /[⚠✷]/);
  });

  it("escalates color at 90% and 95% without emoji glyphs", () => {
    const output = plain(_buildQueueProviderUsageLines(80, 9, [
      {
        provider: "claude",
        source: "anthropic-oauth-usage-api",
        windows: [
          { key: "session", utilizationPct: 90 },
          { key: "week", utilizationPct: 96 },
        ],
      },
    ], {
      currentRunProviderUsage: [{ provider: "claude", usedTokens: 1000 }],
    }));

    assert.match(output, /\[S\] ▕██████████████████░░▏\s+90%/);
    assert.match(output, /\[W\] ▕███████████████████░▏\s+96%/);
    assert.doesNotMatch(output, /[⚠✷]/);
  });

  it("fits compact provider footer rows to the requested line width", () => {
    const width = 44;
    const lines = _buildQueueProviderUsageLines(width, 4, [
      {
        provider: "codex",
        source: "codex-cli-status",
        windows: [
          { key: "session", utilizationPct: 6, resetAt: "2026-05-18T13:31:00.000Z" },
          { key: "week", utilizationPct: 90, resetAt: "2026-05-19T04:00:00.000Z" },
        ],
      },
    ], {
      nowMs: Date.parse("2026-05-18T09:00:00.000Z"),
      currentRunProviderUsage: [{ provider: "codex", usedTokens: 494400, costUsd: 1.56 }],
    });
    const output = plain(lines);

    assert.equal(lines.length, 4);
    assert.ok(lines.every((line) => displayColumnWidth(line) === width - 1));
    assert.match(output, /\[S\] ▕█░░░░░░░░░░░░░░░░░░░▏\s+6% 4h 31m/);
    assert.match(output, /\[W\] ▕██████████████████░░▏\s+90% 19h/);
    assert.doesNotMatch(output, /[⚠✷…]/);
  });

  it("does not treat missing run start as all-time provider usage", async () => {
    await withTempDb(async (db) => {
      db.prepare(`
        INSERT INTO agent_calls (
          role, model_tier, provider, model_name, input_tokens, output_tokens, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("planner", "standard", "codex", "gpt-5.4", 4_000_000, 355_385, "2026-04-24T07:55:53.334Z");

      assert.deepEqual(getCurrentRunProviderUsage(), []);
    });
  });
});
