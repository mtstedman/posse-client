import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { RemotePromptClient, resolvePosseKey } from "../lib/domains/remote/functions/client.js";
import {
  POSSE_REMOTE_DEFAULT_TIMEOUT_MS,
  POSSE_REMOTE_DEFAULT_URL,
} from "../lib/domains/remote/functions/mode.js";
import { buildRemoteCompileRequest } from "../lib/domains/remote/functions/request.js";
import { renderLocalEnrichment } from "../lib/domains/remote/functions/render-enrichment.js";

const REMOTE_URL = process.env.POSSE_REMOTE_PARITY_URL || POSSE_REMOTE_DEFAULT_URL;
const REMOTE_TIMEOUT_MS = Number(process.env.POSSE_REMOTE_PARITY_TIMEOUT_MS || POSSE_REMOTE_DEFAULT_TIMEOUT_MS);

function makeParityPacket(cwd) {
  return {
    recipient: "fix",
    job_type: "fix",
    work_item_id: 10,
    job_id: 20,
    title: "Repair auth validation",
    cwd,
    model_tier: "standard",
    reasoning_effort: "medium",
    governance_tier: "production",
    execution_provider: "claude",
    attempt: {
      count: 2,
      max: 3,
      last_error: "Previous attempt returned 422 with an empty body.",
      escalated: false,
    },
    files_to_modify: ["src/auth.js"],
    related_files: ["src/config.js"],
    related_files_content: {
      "src/config.js": "raw source must stay local",
    },
    success_criteria: ["Validation returns a structured error body"],
    test_command: "npm test -- auth",
    risk: { mutating: true, assessable: true },
    tool_policy: { allow_read: true, allow_write: true, allow_shell: false },
    budgets: { fallback_reads_remaining: 4 },
    project_context: "Small auth service",
    step0_context: "Earlier implementation missed the empty-body case.",
    run_insights: [{
      insight_type: "note",
      insight_kind: "pattern",
      confidence: "high",
      summary: "Keep validation tests focused on the endpoint contract.",
    }],
    skills: [],
    requested_skills: [],
  };
}

function isReachabilityError(err) {
  const text = [
    err?.code,
    err?.cause?.code,
    err?.message,
    err?.cause?.message,
  ].filter(Boolean).join(" ");
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed|POSSE_REMOTE_TIMEOUT/i.test(text);
}

function isMissingRemoteAuth(err) {
  if (![401, 403, 503].includes(Number(err?.status))) return false;
  const text = JSON.stringify(err?.body || {});
  if (/POSSE_KEY is not configured/i.test(text)) return true;
  return /missing Authorization bearer token|unauthorized/i.test(text)
    && !resolvePosseKey();
}

async function compileOrSkip(t, client, request) {
  try {
    return await client.compile(request);
  } catch (err) {
    if (isReachabilityError(err)) {
      t.skip(`posse-remote is not reachable at ${REMOTE_URL}: ${err?.message || err}`);
      return null;
    }
    if (isMissingRemoteAuth(err)) {
      t.skip(`posse-remote requires POSSE_KEY for parity checks at ${REMOTE_URL}`);
      return null;
    }
    throw err;
  }
}

describe("posse remote prompt parity", () => {
  it("resolves POSSE_KEY as the canonical remote auth key", () => {
    assert.equal(resolvePosseKey({ POSSE_KEY: "new-key" }), "new-key");
    assert.equal(resolvePosseKey({ POSSE_REMOTE_API_KEY: "old-key" }), "");
    assert.equal(resolvePosseKey({
      POSSE_KEY: "new-key",
      POSSE_REMOTE_API_KEY: "old-key",
    }), "new-key");
  });

  it("renders first-class parity fields without leaking client extra", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "posse-remote-parity-"));
    try {
      fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "src", "auth.js"), "export function validate() { return true; }\n", "utf8");
      fs.writeFileSync(path.join(tmp, "src", "config.js"), "export const strict = true;\n", "utf8");

      const packet = makeParityPacket(tmp);
      const request = buildRemoteCompileRequest(packet, "Fix the validation failure.");
      assert.equal(request.options.embed_extra, false);
      assert.doesNotMatch(JSON.stringify(request), /raw source must stay local/);

      const client = new RemotePromptClient({
        baseUrl: REMOTE_URL,
        timeoutMs: Number.isFinite(REMOTE_TIMEOUT_MS) && REMOTE_TIMEOUT_MS > 0
          ? REMOTE_TIMEOUT_MS
          : POSSE_REMOTE_DEFAULT_TIMEOUT_MS,
      });
      const response = await compileOrSkip(t, client, request);
      if (!response) return;

      const skeleton = response.final_prompt || [
        response.system_prompt,
        response.stable_context,
        response.user_prompt,
      ].filter(Boolean).join("\n\n");

      assert.match(skeleton, /ROLE CLASS: fix/);
      assert.match(skeleton, /PREVIOUS ATTEMPT FAILED/);
      assert.match(skeleton, /SUCCESS CRITERIA \(literal JSON string\):/);
      assert.match(skeleton, /TEST COMMAND \(literal JSON string\):/);
      assert.match(skeleton, /GOVERNANCE TIER: PRODUCTION/);
      assert.match(skeleton, /CONTEXT FROM PREVIOUS RUNS \(literal JSON string\):/);
      assert.match(skeleton, /\[NOTE\/pattern\/high\] Keep validation tests focused/);
      assert.doesNotMatch(skeleton, /EXTRA CLIENT METADATA/);
      assert.doesNotMatch(skeleton, /local_prompt_contract/);
      assert.doesNotMatch(skeleton, /raw source must stay local/);

      const enrichment = renderLocalEnrichment(response.handoff, { cwd: tmp });
      assert.match(enrichment, /LOCAL ENRICHMENT BLOCK/);
      assert.match(enrichment, /EDITABLE FILE CONTENT/);
      assert.match(enrichment, /src\/auth\.js/);
      assert.match(enrichment, /1\texport function validate/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
