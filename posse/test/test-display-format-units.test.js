import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { C } from "../lib/shared/format/functions/colors.js";
import { fit, stripAnsi } from "../lib/shared/format/functions/ansi.js";
import {
  modelTierColorKey,
  statusColor,
  statusColorKey,
  statusIcon,
} from "../lib/domains/ui/functions/display/status-palette.js";
import { computeJobProgressStats } from "../lib/domains/ui/functions/display/helpers/job-status.js";
import { _sanitizeDisplayLine } from "../lib/domains/ui/functions/display/helpers/formatters.js";
import {
  formatDuration,
  formatSignedTokens,
  formatTokens,
  formatUsd,
  formatUsdOrNull,
} from "../lib/shared/format/functions/units.js";

describe("display unit formatters", () => {
  it("uses one token, duration, and USD convention", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(1234), "1.2K");
    assert.equal(formatTokens(1_234_567), "1.2M");
    assert.equal(formatSignedTokens(-1234), "-1.2K");

    assert.equal(formatDuration(0), "0s");
    assert.equal(formatDuration(1500), "1.5s");
    assert.equal(formatDuration(90_000), "1m 30s");
    assert.equal(formatDuration(5_400_000), "1h 30m");

    assert.equal(formatUsd(0), "$0.00");
    assert.equal(formatUsd(1.234), "$1.23");
    assert.equal(formatUsd(0.1234), "$0.123");
    assert.equal(formatUsdOrNull(0), null);
  });
});

describe("ANSI fitting", () => {
  it("resets colored text before padding so color does not bleed", () => {
    const fitted = fit(`${C.red}ERR`, 6, { reset: C.reset });
    assert.equal(stripAnsi(fitted), "ERR   ");
    assert.equal(fitted, `${C.red}ERR${C.reset}   `);
  });

  it("preserves SGR color while stripping cursor controls from display lines", () => {
    const input = `${C.green}ok${C.reset}\x1b[2J\x1b[?1049h\x1b]0;owned\x07\x1bPpayload\x1b\\ danger\r\nnext\tcol`;
    const output = _sanitizeDisplayLine(input);
    assert.equal(output, `${C.green}ok${C.reset} danger next  col`);
    assert.doesNotMatch(output, /\x1b\[2J|\x1b\[\?1049h|\x1b\]0;|\x1bP/);
  });

  it("keeps explicit SGR escapes intact instead of rendering bracket noise", () => {
    const input = "\x1b[32mBoot complete - entering main loop\x1b[0m";
    const output = _sanitizeDisplayLine(input);
    assert.equal(output, input);
    assert.equal(stripAnsi(output), "Boot complete - entering main loop");
    assert.doesNotMatch(output, /^\[32m/);
  });
});

describe("display status palette", () => {
  it("centralizes status colors, icons, and model tier colors", () => {
    assert.equal(statusColorKey("running"), "blue");
    assert.equal(statusColorKey("awaiting_assessment"), "yellow");
    assert.equal(statusColorKey("canceled"), "red");
    assert.equal(statusColor("succeeded"), C.green);
    assert.equal(statusIcon("dead_letter"), `${C.red}!!`);
    assert.equal(statusIcon("complete", { kind: "work_item" }), `${C.green}+`);
    assert.equal(modelTierColorKey("strong"), "magenta");
  });

  it("counts all terminal jobs as progress", () => {
    const stats = computeJobProgressStats([
      { id: 1, status: "succeeded" },
      { id: 2, status: "failed" },
      { id: 3, status: "canceled" },
      { id: 4, status: "running" },
      { id: 5, status: "queued" },
    ]);

    assert.equal(stats.total, 5);
    assert.equal(stats.resolved, 3);
    assert.equal(stats.succeeded, 1);
    assert.equal(stats.failed, 1);
    assert.equal(stats.canceled, 1);
    assert.equal(stats.fraction, 0.6);
  });
});
