import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { RemoteComposer } from "../lib/domains/remote/classes/RemoteComposer.js";
import { RemotePromptClient } from "../lib/domains/remote/functions/client.js";
import { RemoteAtlasEncoderClient } from "../lib/domains/remote/functions/atlas-encoder-client.js";
import {
  getPosseRemoteTimeoutMs,
  getPosseRemoteUrl,
  POSSE_REMOTE_DEFAULT_TIMEOUT_MS,
  POSSE_REMOTE_DEFAULT_URL,
} from "../lib/domains/remote/functions/mode.js";
import {
  checkRemotePromptBundleReadiness,
  checkRemotePromptCompilerReadiness,
  validateRemotePromptBundleReadinessResponse,
  validateRemoteCompileReadinessResponse,
} from "../lib/domains/remote/functions/readiness.js";
import {
  getPromptBundleVersion,
  resetActivePromptBundleForTest,
  setActivePromptBundleForTest,
  SUPPORTED_PROMPT_BUNDLE_SCHEMA_VERSION,
} from "../lib/domains/remote/functions/prompt-bundle.js";
import { buildRemoteCompileRequest } from "../lib/domains/remote/functions/request.js";
import { renderLocalEnrichment } from "../lib/domains/remote/functions/render-enrichment.js";
import { renderAtlasHandoffSections } from "../lib/domains/handoff/functions/helpers/atlas-context.js";
import { buildPromptAsync, composePromptRemoteAware } from "../lib/domains/handoff/functions/index.js";
import { composeRemoteAssessorPromptForProvider } from "../lib/domains/providers/functions/helpers/remote-assessor-prompt.js";
import { seedAccountSetting, withTempRuntimeDb } from "./helpers/regression-test-harness.js";

function makePacket(overrides = {}) {
  return {
    recipient: "dev",
    job_type: "dev",
    work_item_id: 1,
    job_id: 2,
    title: "Update auth",
    cwd: process.cwd(),
    model_tier: "standard",
    reasoning_effort: "medium",
    governance_tier: "mvp",
    execution_provider: "claude",
    attempt: { count: 1, max: 3, last_error: null, escalated: false },
    files_to_modify: ["src/auth.js"],
    files_to_create: [],
    files_to_delete: [],
    create_roots: [],
    related_files: ["src/config.js"],
    related_files_content: { "src/config.js": "raw local content that must not be sent" },
    success_criteria: ["Auth passes"],
    test_command: "npm test",
    risk: { mutating: true, assessable: true },
    tool_policy: { allow_read: true, allow_write: true, allow_shell: false },
    budgets: { fallback_reads_remaining: 4 },
    editable_files: {},
    smart_preloads: {},
    creatable_files: {},
    directory_tree: null,
    source_files: {},
    dropped_files: [],
    project_context: "Project summary",
    step0_context: "Prior context",
    run_insights: [{
      insight_type: "note",
      insight_kind: "pattern",
      confidence: "high",
      summary: "Prefer scoped auth helper tests",
    }],
    skills: ["security"],
    requested_skills: ["security"],
    prompt: null,
    ...overrides,
  };
}

function remoteReadinessResponse(overrides = {}) {
  return {
    prompt_version: "test-prompt-version",
    service_url: "https://api.yourposseai.com",
    system_prompt: [
      "ROLE CLASS: dev",
      "FILE SCOPE CONTRACT",
      "DEV LOG FORMAT",
    ].join("\n"),
    stable_context: [
      "STABLE EXECUTION CONTEXT",
      "source_policy: no_raw_source",
      "enrichment_owner: local_client",
      "tool_surface:",
      "tool_policy:",
      "files_to_modify:",
    ].join("\n"),
    user_prompt: [
      "INSTRUCTIONS (literal JSON string):",
      "PREVIOUS ATTEMPT FAILED",
      "SUCCESS CRITERIA (literal JSON string):",
      "TEST COMMAND (literal JSON string):",
      "GOVERNANCE TIER: PRODUCTION",
      "CONTEXT FROM PREVIOUS RUNS",
      "PROJECT SUMMARY (literal JSON string):",
      "HISTORICAL INSIGHTS",
    ].join("\n"),
    final_prompt: "ROLE CLASS: dev\n\nSTABLE EXECUTION CONTEXT\n\nINSTRUCTIONS (literal JSON string):",
    handoff: {
      source_policy: "no_raw_source",
      enrichment_owner: "local_client",
      enrichment_stage: "before_provider_call",
      files: {
        files_to_modify: [{ path: "src/remote-readiness-probe.js" }],
        read_only_context: [{ path: "src/remote-readiness-probe.js" }],
      },
      instructions: ["Use this handoff packet locally."],
    },
    metadata: {
      resolved_role: "dev",
      prompt_chars: 1234,
      raw_source_omitted_files: ["src/remote-readiness-probe.js"],
    },
    ...overrides,
  };
}

function remotePromptBundleResponse(overrides = {}) {
  return {
    schema_version: 1,
    prompt_version: "test-prompt-version",
    roles: {
      researcher: { markdown: "You are the RESEARCHER." },
      planner: { markdown: "You are the PLANNER." },
      dev: { markdown: "You are the DEV AGENT." },
      assessor: { markdown: "You are the ASSESSOR." },
      preflight: { markdown: "You are the PREFLIGHT ROUTER." },
    },
    contracts: {
      "rule-priority": { markdown: "RULE PRIORITY ORDER" },
      "file-scope": { markdown: "FILE SCOPE CONTRACT" },
      "task-modes": { markdown: "TASK MODES" },
      "researcher-output": { markdown: "RESEARCHER OUTPUT CONTRACT" },
      "dev-log": { markdown: "DEV LOG FORMAT" },
    },
    role_contracts: {
      researcher: ["rule-priority", "researcher-output"],
      planner: ["rule-priority", "file-scope", "task-modes"],
      dev: ["rule-priority", "file-scope", "dev-log"],
      assessor: ["rule-priority", "file-scope", "task-modes"],
      preflight: [],
    },
    skills: [{
      id: "security",
      name: "Security",
      description: "Secure implementation guidance.",
      applies_to: ["dev"],
      when_to_use: "Security work",
      recycle_session: false,
      body: "Treat security as a design constraint.",
    }],
    ...overrides,
  };
}

describe("posse remote prompt composition", () => {
  it("resolves remote compiler URL and timeout from account settings instead of env overrides", () => withTempRuntimeDb((root) => {
    assert.equal(getPosseRemoteUrl({}), POSSE_REMOTE_DEFAULT_URL);
    assert.equal(getPosseRemoteTimeoutMs({}), POSSE_REMOTE_DEFAULT_TIMEOUT_MS);
    seedAccountSetting(
      path.join(root, ".posse", "account.db"),
      "posse_remote_url",
      "https://settings-remote.example.test/",
    );
    seedAccountSetting(
      path.join(root, ".posse", "account.db"),
      "posse_remote_timeout_ms",
      "7000",
    );

    assert.equal(
      getPosseRemoteUrl({ POSSE_REMOTE_URL: "https://env-remote.example.test/" }),
      "https://settings-remote.example.test/",
    );
    assert.equal(getPosseRemoteTimeoutMs({ POSSE_REMOTE_TIMEOUT_MS: "9000" }), 7000);
  }));

  it("uses the runtime remote timeout default in the prompt client", () => {
    const client = new RemotePromptClient({
      baseUrl: "https://api.yourposseai.com",
      timeoutMs: 0,
      fetchImpl: async () => {
        throw new Error("not called");
      },
    });

    assert.equal(client.timeoutMs, POSSE_REMOTE_DEFAULT_TIMEOUT_MS);
  });

  it("refuses bearer auth over non-loopback HTTP remote URLs", () => {
    assert.throws(
      () => new RemotePromptClient({
        baseUrl: "http://example.test",
        apiKey: "remote-secret-token",
        fetchImpl: async () => ({ ok: true, status: 200, statusText: "OK", text: async () => "{}" }),
      }),
      (err) => {
        assert.equal(err.code, "POSSE_REMOTE_INSECURE_AUTH");
        assert.match(err.message, /refuses to send authorization over http:/);
        return true;
      },
    );

    assert.throws(
      () => new RemoteAtlasEncoderClient({
        baseUrl: "http://example.test",
        apiKey: "remote-secret-token",
        fetchImpl: async () => ({ ok: true, status: 200, statusText: "OK", text: async () => "{}" }),
      }),
      (err) => err?.code === "POSSE_REMOTE_INSECURE_AUTH",
    );
  });

  it("allows bearer auth over loopback HTTP remote URLs for local development", async () => {
    let seen = null;
    const client = new RemotePromptClient({
      baseUrl: "http://127.0.0.1:8080",
      apiKey: "test-key",
      fetchImpl: async (url, opts) => {
        seen = { url, opts };
        return { ok: true, status: 200, statusText: "OK", text: async () => "{}" };
      },
    });

    await client.compile({ role: "dev" });

    assert.equal(seen.url, "http://127.0.0.1:8080/v1/prompts/compile");
    assert.equal(seen.opts.headers.authorization, "Bearer test-key");
  });

  it("delegates prompt HTTP to the native remote binary when staged", async () => {
    const capture = {};
    const nativeManager = {
      shouldUse(name) {
        capture.shouldUse = name;
        return true;
      },
      binary(name) {
        capture.binary = name;
        return {
          async run(command, args, opts) {
            capture.command = command;
            capture.args = args;
            capture.opts = opts;
            return {
              ok: true,
              code: 0,
              stdout: "",
              stderr: "",
              error: null,
              json: { ok: true, data: { prompt_version: "native-v1", system_prompt: "REMOTE SYSTEM" } },
            };
          },
        };
      },
    };
    const client = new RemotePromptClient({
      baseUrl: "https://api.yourposseai.com",
      apiKey: "test-key",
      nativeManager,
      nativeAuth: { heartbeatUrl: "https://api.yourposseai.com/v1/native/heartbeat" },
    });

    const result = await client.compile({ role: "dev" });
    const envelope = JSON.parse(capture.opts.input);

    assert.equal(capture.shouldUse, "remote");
    assert.equal(capture.binary, "remote");
    assert.equal(capture.command, "request-json");
    assert.deepEqual(capture.args, []);
    assert.equal(capture.opts.key, "test-key");
    assert.equal(envelope.protocol, "posse.remote.native.v1");
    assert.equal(envelope.method, "request-json");
    assert.deepEqual(envelope.auth, { heartbeatUrl: "https://api.yourposseai.com/v1/native/heartbeat" });
    assert.deepEqual(envelope.payload, {
      baseUrl: "https://api.yourposseai.com",
      path: "/v1/prompts/compile",
      method: "POST",
      body: { role: "dev" },
      operation: "remote prompt compile",
      timeoutMs: 60000,
      maxRetries: 1,
      retryDelayMs: 100,
      maxResponseBytes: 1048576,
    });
    assert.equal(result.prompt_version, "native-v1");
  });

  it("does not route through the native remote binary without heartbeat auth config", () => {
    let checked = false;
    const client = new RemotePromptClient({
      baseUrl: "https://api.yourposseai.com",
      apiKey: "test-key",
      nativeAuth: {},
      nativeManager: {
        shouldUse() {
          checked = true;
          return true;
        },
      },
    });

    assert.equal(client.shouldUseNativeClient(), false);
    assert.equal(checked, false);
  });

  it("ignores the legacy localhost remote compiler default from persisted settings", () => withTempRuntimeDb((root) => {
    seedAccountSetting(
      path.join(root, ".posse", "account.db"),
      "posse_remote_url",
      "http://127.0.0.1:8080",
    );

    assert.equal(getPosseRemoteUrl({}), POSSE_REMOTE_DEFAULT_URL);
  }));

  it("reports remote compiler fetch failures with endpoint details", async () => {
    const client = new RemotePromptClient({
      baseUrl: "https://remote-dev.example.test",
      fetchImpl: async () => {
        const err = new TypeError("fetch failed");
        err.cause = { code: "ENOTFOUND", address: "remote-dev.example.test" };
        throw err;
      },
    });

    await assert.rejects(
      () => client.compile({ role: "dev" }),
      /https:\/\/remote-dev\.example\.test\/v1\/prompts\/compile.*ENOTFOUND/,
    );
  });

  it("reports remote compiler HTTP error bodies clearly", async () => {
    const client = new RemotePromptClient({
      baseUrl: "https://api.yourposseai.com",
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => JSON.stringify({
          error: {
            code: "unauthorized",
            message: "missing Authorization bearer token",
          },
        }),
      }),
    });

    await assert.rejects(
      () => client.compile({ role: "dev" }),
      /401 Unauthorized - unauthorized: missing Authorization bearer token/,
    );
  });

  it("validates the remote cutover readiness contract", () => {
    const validation = validateRemoteCompileReadinessResponse(remoteReadinessResponse());

    assert.equal(validation.ok, true);
    assert.deepEqual(validation.errors, []);
  });

  it("rejects remote readiness responses missing required prompt sections", () => {
    const validation = validateRemoteCompileReadinessResponse(remoteReadinessResponse({
      user_prompt: "INSTRUCTIONS (literal JSON string):",
    }));

    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((error) => error.includes("SUCCESS CRITERIA")));
    assert.ok(validation.errors.some((error) => error.includes("PROJECT SUMMARY")));
  });

  it("readiness check calls the remote compile route and validates the response", async () => {
    let seenRequest = null;
    const result = await checkRemotePromptCompilerReadiness({
      cwd: process.cwd(),
      client: {
        compile: async (request) => {
          seenRequest = request;
          return remoteReadinessResponse();
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.promptVersion, "test-prompt-version");
    assert.equal(seenRequest.role, "dev");
    assert.equal(seenRequest.options.include_final_prompt, true);
    assert.equal(seenRequest.tool_surface, undefined);
    assert.equal(seenRequest.tool_policy, undefined);
    assert.deepEqual(seenRequest.capabilities.tools, {
      read: true,
      write: true,
      shell: true,
      image_generation: false,
    });
    assert.equal(seenRequest.capabilities.atlas.available, true);
    assert.ok(seenRequest.context.file_snippets.some((snippet) =>
      snippet.path === "src/remote-readiness-probe.js" &&
      /RAW_SOURCE_SENTINEL/.test(snippet.content || "")
    ));
  });

  it("fetches the remote tool-suite catalog", async () => {
    let seen = null;
    const client = new RemotePromptClient({
      baseUrl: "https://api.yourposseai.com/",
      apiKey: "test-key",
      fetchImpl: async (url, opts) => {
        seen = { url, opts };
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({
            policy_source: "posse-remote",
            suites: [{ id: "atlas", tool_names: ["context"] }],
          }),
        };
      },
    });

    const result = await client.getToolSuites();

    assert.equal(seen.url, "https://api.yourposseai.com/v1/catalog/tool-suites");
    assert.equal(seen.opts.method, "GET");
    assert.equal(seen.opts.headers.authorization, "Bearer test-key");
    assert.equal(seen.opts.headers["content-type"], undefined);
    assert.equal(result.policy_source, "posse-remote");
    assert.equal(result.suites[0].id, "atlas");
  });

  it("fetches the remote prompt bundle and keeps selected skills local-policy filtered", async () => {
    let seen = null;
    const client = new RemotePromptClient({
      baseUrl: "https://api.yourposseai.com/",
      apiKey: "test-key",
      fetchImpl: async (url, opts) => {
        seen = { url, opts };
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify(remotePromptBundleResponse()),
        };
      },
    });

    const bundle = await client.getPromptBundle();
    assert.equal(seen.url, "https://api.yourposseai.com/v1/prompts/bundle");
    assert.equal(seen.opts.method, "GET");
    assert.equal(seen.opts.headers.authorization, "Bearer test-key");
    assert.equal(bundle.prompt_version, "test-prompt-version");

    const request = buildRemoteCompileRequest(makePacket({
      skills: ["security", "disabled-local"],
      requested_skills: ["security", "disabled-local"],
      skills_attached: ["security"],
    }), "Do the work.");
    assert.deepEqual(request.skills, ["security"]);
    assert.deepEqual(request.requested_skills, ["security", "disabled-local"]);
  });

  it("rejects unsupported remote prompt bundle schema versions", () => {
    try {
      assert.throws(
        () => setActivePromptBundleForTest(remotePromptBundleResponse({
          schema_version: SUPPORTED_PROMPT_BUNDLE_SCHEMA_VERSION + 1,
        })),
        /schema_version mismatch/,
      );
    } finally {
      resetActivePromptBundleForTest();
    }
  });

  it("rejects oversized remote prompt responses before JSON parsing", async () => {
    const client = new RemotePromptClient({
      baseUrl: "https://api.yourposseai.com/",
      maxResponseBytes: 8,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{\"too\":\"large\"}"));
            controller.close();
          },
        }),
      }),
    });

    await assert.rejects(
      () => client.getPromptBundle(),
      (err) => {
        assert.equal(err.code, "POSSE_REMOTE_RESPONSE_TOO_LARGE");
        assert.equal(err.maxResponseBytes, 8);
        return true;
      },
    );
  });

  it("validates and loads the remote prompt bundle readiness contract", async () => {
    try {
      setActivePromptBundleForTest(remotePromptBundleResponse());
      const validation = validateRemotePromptBundleReadinessResponse(await checkRemotePromptBundleReadiness({
        client: {
          getPromptBundle: async () => remotePromptBundleResponse(),
        },
      }).then(() => {
        return {
          schema_version: 1,
          prompt_version: "test-prompt-version",
          roles: new Map(Object.entries(remotePromptBundleResponse().roles)),
          contracts: new Map(Object.entries(remotePromptBundleResponse().contracts)),
          role_contracts: new Map(Object.entries(remotePromptBundleResponse().role_contracts)),
          skills: remotePromptBundleResponse().skills,
        };
      }));
      assert.equal(validation.ok, true);
      assert.deepEqual(validation.errors, []);
    } finally {
      resetActivePromptBundleForTest();
    }
  });

  it("flags unsupported remote prompt bundle schema versions during readiness validation", () => {
    const validation = validateRemotePromptBundleReadinessResponse({
      schema_version: SUPPORTED_PROMPT_BUNDLE_SCHEMA_VERSION + 1,
      prompt_version: "test-prompt-version",
      roles: new Map(Object.entries(remotePromptBundleResponse().roles)),
      contracts: new Map(Object.entries(remotePromptBundleResponse().contracts)),
      role_contracts: new Map(Object.entries(remotePromptBundleResponse().role_contracts)),
      skills: remotePromptBundleResponse().skills,
    });

    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((error) => error.includes("schema_version mismatch")));
  });

  it("flags missing required remote role contract mappings during readiness validation", () => {
    const bundle = remotePromptBundleResponse({
      role_contracts: {
        researcher: ["rule-priority", "researcher-output"],
        dev: ["rule-priority", "file-scope", "dev-log"],
        assessor: ["rule-priority", "file-scope", "task-modes"],
        preflight: [],
      },
    });
    const validation = validateRemotePromptBundleReadinessResponse({
      schema_version: SUPPORTED_PROMPT_BUNDLE_SCHEMA_VERSION,
      prompt_version: "test-prompt-version",
      roles: new Map(Object.entries(bundle.roles)),
      contracts: new Map(Object.entries(bundle.contracts)),
      role_contracts: new Map(Object.entries(bundle.role_contracts)),
      skills: bundle.skills,
    });

    assert.equal(validation.ok, false);
    assert.ok(validation.errors.includes("planner role contract mapping missing"));
  });

  it("resolves the remote namespaced tool surface", async () => {
    let seen = null;
    const client = new RemotePromptClient({
      baseUrl: "https://api.yourposseai.com/",
      apiKey: "test-key",
      fetchImpl: async (url, opts) => {
        seen = { url, opts };
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({
            policy_source: "posse-remote",
            gateway_server_name: "posse-gateway",
            tools: [
              { name: "tools.read_file", suite: "tools", local_name: "read_file" },
              { name: "atlas.context", suite: "atlas", local_name: "context" },
            ],
          }),
        };
      },
    });

    const request = {
      role: "planner",
      provider: "codex",
      requested_suites: ["tools", "atlas"],
      local_capabilities: {
        tools: { read: true, write: false, shell: false },
        atlas: { available: true, backend: "v2" },
      },
    };
    const result = await client.resolveToolSurface(request);

    assert.equal(seen.url, "https://api.yourposseai.com/v1/catalog/tool-surface");
    assert.equal(seen.opts.method, "POST");
    assert.equal(seen.opts.headers.authorization, "Bearer test-key");
    assert.equal(seen.opts.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(seen.opts.body).requested_suites, ["tools", "atlas"]);
    assert.deepEqual(result.tools.map((tool) => tool.name), ["tools.read_file", "atlas.context"]);
  });

  it("retries transient remote compiler timeouts once", async () => {
    let calls = 0;
    const client = new RemotePromptClient({
      baseUrl: "https://api.yourposseai.com",
      maxRetries: 1,
      retryDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ final_prompt: "REMOTE OK" }),
        };
      },
    });

    const result = await client.compile({ role: "dev" });
    assert.equal(calls, 2);
    assert.equal(result.final_prompt, "REMOTE OK");
  });

  it("retries transient remote prompt bundle fetch failures once", async () => {
    let calls = 0;
    const client = new RemotePromptClient({
      baseUrl: "https://api.yourposseai.com",
      maxRetries: 1,
      retryDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify(remotePromptBundleResponse()),
        };
      },
    });

    const result = await client.getPromptBundle();
    assert.equal(calls, 2);
    assert.equal(result.prompt_version, "test-prompt-version");
  });

  it("reports retry count when transient remote compiler failures persist", async () => {
    let calls = 0;
    const client = new RemotePromptClient({
      baseUrl: "https://api.yourposseai.com",
      maxRetries: 1,
      retryDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    });

    await assert.rejects(
      () => client.compile({ role: "dev" }),
      (err) => {
        assert.equal(calls, 2);
        assert.equal(err.code, "POSSE_REMOTE_TIMEOUT");
        assert.equal(err.attempts, 2);
        assert.match(err.message, /after 2 attempts/);
        return true;
      },
    );
  });

  it("does not retry remote compiler timeouts from the handoff composer by default", async () => {
    let calls = 0;
    const composer = new RemoteComposer({
      clientOptions: {
        fetchImpl: async () => {
          calls += 1;
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        },
      },
    });

    await assert.rejects(
      () => composer.composePrompt(makePacket(), "Do work."),
      (err) => {
        assert.equal(calls, 1);
        assert.equal(err.code, "POSSE_REMOTE_TIMEOUT");
        assert.equal(err.attempts, undefined);
        return true;
      },
    );
  });

  it("redacts socket address and port details from remote prompt fetch failures", async () => {
    const client = new RemotePromptClient({
      baseUrl: "https://api.yourposseai.com",
      maxRetries: 0,
      fetchImpl: async () => {
        const err = new Error("fetch failed");
        err.cause = { code: "ECONNREFUSED", address: "10.8.0.12", port: 4317 };
        throw err;
      },
    });

    await assert.rejects(
      () => client.compile({ role: "dev" }),
      (err) => {
        assert.equal(err.code, "POSSE_REMOTE_FETCH_FAILED");
        assert.match(err.message, /ECONNREFUSED/);
        assert.doesNotMatch(err.message, /10\.8\.0\.12/);
        assert.doesNotMatch(err.message, /4317/);
        return true;
      },
    );
  });

  it("redacts socket address and port details from remote ATLAS encoder fetch failures", async () => {
    const client = new RemoteAtlasEncoderClient({
      baseUrl: "https://api.yourposseai.com",
      maxRetries: 0,
      fetchImpl: async () => {
        const err = new Error("fetch failed");
        err.cause = { code: "ECONNREFUSED", address: "10.8.0.13", port: 4318 };
        throw err;
      },
    });

    await assert.rejects(
      () => client.encodeBatch({ texts: ["hello"] }),
      (err) => {
        assert.equal(err.code, "POSSE_REMOTE_ATLAS_ENCODER_FETCH_FAILED");
        assert.match(err.message, /ECONNREFUSED/);
        assert.doesNotMatch(err.message, /10\.8\.0\.13/);
        assert.doesNotMatch(err.message, /4318/);
        return true;
      },
    );
  });

  it("builds compile requests without raw file content", () => {
    const request = buildRemoteCompileRequest(makePacket(), "Do work.");

    assert.equal(request.role, "dev");
    assert.equal(request.provider, "claude");
    assert.deepEqual(request.scope.files_to_modify, ["src/auth.js"]);
    assert.equal(request.scope.test_command, "npm test");
    assert.equal(request.context.file_snippets[0].path, "src/config.js");
    assert.equal(request.context.file_snippets[0].content, undefined);
    assert.doesNotMatch(JSON.stringify(request), /raw local content/);
  });

  it("sends local execution capabilities and lets remote issue tools", () => {
    const request = buildRemoteCompileRequest(makePacket({
      capabilities: {
        tools: { read: true, write: true, shell: true, image_generation: false },
      },
    }), "Do work.");

    assert.equal(request.tool_surface, undefined);
    assert.equal(request.tool_contract, undefined);
    assert.equal(request.tool_policy, undefined);
    assert.deepEqual(request.capabilities.tools, {
      read: true,
      write: true,
      shell: true,
      image_generation: false,
    });
    assert.deepEqual(request.scope.files_to_modify, ["src/auth.js"]);
    assert.doesNotMatch(JSON.stringify(request), /You are the DEV AGENT|FILE SCOPE CONTRACT|DEV LOG FORMAT/);
  });

  it("can report unavailable local shell capability without issuing policy", () => {
    const request = buildRemoteCompileRequest(makePacket({
      capabilities: {
        tools: { read: true, write: true, shell: false },
      },
    }), "Do work.");

    assert.equal(request.capabilities.tools.shell, false);
    assert.equal(request.tool_surface, undefined);
    assert.equal(request.tool_contract, undefined);
  });

  it("sends role facts instead of role-sensitive local tool contracts", () => {
    const plannerRequest = buildRemoteCompileRequest(makePacket({
      recipient: "planner",
      job_type: "plan",
    }), "Plan work.");
    assert.equal(plannerRequest.role, "planner");
    assert.equal(plannerRequest.job_type, "plan");
    assert.equal(plannerRequest.tool_surface, undefined);
    assert.equal(plannerRequest.tool_contract, undefined);

    const researcherRequest = buildRemoteCompileRequest(makePacket({
      recipient: "researcher",
      job_type: "research",
    }), "Research work.");
    assert.equal(researcherRequest.role, "researcher");
    assert.equal(researcherRequest.job_type, "research");
    assert.equal(researcherRequest.tool_surface, undefined);

    const artificerRequest = buildRemoteCompileRequest(makePacket({
      recipient: "artificer",
      job_type: "artificer",
      needs_image_generation: true,
    }), "Create assets.");
    assert.equal(artificerRequest.role, "artificer");
    assert.equal(artificerRequest.capabilities.tools.image_generation, true);
  });

  it("reports Atlas availability without sending a local Atlas route", () => {
    const request = buildRemoteCompileRequest(makePacket({
      atlas: {
        active: true,
        prefetchFailed: false,
        tools: ["repo.status", "context", "symbol.search", "file.read", "file.write", "not.real"],
        summary: "ATLAS is warm",
        memoryStats: { memories: 4, feedbackSignals: 0 },
      },
    }), "Do work.");

    assert.equal(request.capabilities.atlas.available, true);
    assert.equal(request.capabilities.atlas.backend, "v2");
    assert.equal(request.capabilities.atlas.memory_count, 4);
    assert.equal(request.tool_surface, undefined);
    assert.equal(request.tool_contract, undefined);
    assert.doesNotMatch(JSON.stringify(request), /not\.real|file\.write|repo\.status/);
    assert.equal(request.context.atlas_summary, "ATLAS is warm");
  });

  it("renders local enrichment from remote handoff file metadata", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "posse-remote-"));
    try {
      fs.mkdirSync(path.join(tmp, "src"));
      fs.writeFileSync(path.join(tmp, "src", "auth.js"), "export const ok = true;\n", "utf8");
      const text = renderLocalEnrichment({
        files: {
          files_to_modify: [{ path: "src/auth.js", kind: "editable", required: true }],
          read_only_context: [],
        },
      }, { cwd: tmp });

      assert.match(text, /LOCAL ENRICHMENT BLOCK/);
      assert.match(text, /EDITABLE FILE CONTENT/);
      assert.match(text, /1\texport const ok = true;/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not inline sensitive env files during local enrichment", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "posse-remote-"));
    try {
      fs.writeFileSync(path.join(tmp, ".env"), "SECRET_TOKEN=do-not-inline\n", "utf8");
      fs.writeFileSync(path.join(tmp, ".env.local"), "LOCAL_SECRET=also-private\n", "utf8");
      const text = renderLocalEnrichment({
        files: {
          files_to_modify: [{ path: ".env", kind: "editable", required: true }],
          read_only_context: [{ path: ".env.local", kind: "context", required: true }],
        },
      }, { cwd: tmp });

      assert.match(text, /sensitive env file/);
      assert.doesNotMatch(text, /do-not-inline/);
      assert.doesNotMatch(text, /also-private/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("composes a remote skeleton with local enrichment", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "posse-remote-"));
    try {
      fs.mkdirSync(path.join(tmp, "src"));
      fs.writeFileSync(path.join(tmp, "src", "auth.js"), "export const ok = true;\n", "utf8");
      const packet = makePacket({
        cwd: tmp,
        atlas: { active: true, prefetchFailed: false },
        tool_policy: { allow_read: true, allow_write: true, allow_shell: true },
      });
      const composer = new RemoteComposer({
        client: {
          compile: async () => ({
            prompt_version: "test",
            system_prompt: "REMOTE SYSTEM",
            stable_context: "REMOTE STABLE",
            user_prompt: "REMOTE USER",
            final_prompt: "REMOTE SYSTEM\n\nREMOTE STABLE\n\nREMOTE USER",
            handoff: {
              cwd: tmp,
              tool_policy: { allow_read: true, allow_write: true, allow_shell: true, fallback_reads: 3 },
              files: {
                files_to_modify: [{ path: "src/auth.js", kind: "editable", required: true }],
                read_only_context: [],
              },
              omitted_raw_source_files: [],
            },
            issuance: {
              source: "posse-remote",
              role: "dev",
              provider: "claude",
              tool_policy: { allow_read: true, allow_write: true, allow_shell: true, fallback_reads: 3 },
              tool_surface: ["tools.read_file", "tools.write_file", "atlas.symbol.search"],
              atlas: {
                available: true,
                route_phase: "dev",
                rationale: "test",
                agent_surface: ["atlas.symbol.search"],
                prefetch_surface: ["atlas.context"],
                internal_surface: ["atlas.repo.status"],
              },
            },
            metadata: { prompt_chars: 15 },
          }),
        },
      });

      const result = await composer.composePrompt(packet, "Do work.");

      assert.equal(result.systemPrompt, "REMOTE SYSTEM");
      assert.equal(result.stableContext, "REMOTE STABLE");
      assert.match(result.userPrompt, /^REMOTE USER/);
      assert.match(result.prompt, /^REMOTE SYSTEM/);
      assert.match(result.prompt, /LOCAL ENRICHMENT BLOCK/);
      assert.doesNotMatch(result.userPrompt, /REMOTE SYSTEM/);
      assert.doesNotMatch(result.userPrompt, /REMOTE STABLE/);
      assert.match(result.prompt, /src\/auth\.js/);
      assert.equal(result.metadata.prompt_version, "test");
      assert.deepEqual(packet.remote_tool_surface, ["tools.read_file", "tools.write_file", "atlas.symbol.search"]);
      assert.deepEqual(packet.tool_policy, { allow_read: true, allow_write: true, allow_shell: true });
      assert.equal(packet.budgets.fallback_reads_remaining, 3);
      assert.deepEqual(packet.atlas.remoteAgentSurface, ["atlas.symbol.search"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps remote issuance from raising the local fallback-read budget", async () => {
    const packet = makePacket({ budgets: { fallback_reads_remaining: 1 } });
    const composer = new RemoteComposer({
      client: {
        compile: async () => ({
          prompt_version: "test",
          user_prompt: "REMOTE USER",
          final_prompt: "REMOTE USER",
          handoff: { files: { files_to_modify: [], read_only_context: [] }, omitted_raw_source_files: [] },
          issuance: {
            source: "posse-remote",
            role: "dev",
            provider: "claude",
            tool_policy: { allow_read: true, allow_write: true, allow_shell: true, fallback_reads: 5 },
            tool_surface: ["tools.read_file"],
            atlas: { available: false, route_phase: "dev", rationale: "test", agent_surface: [], prefetch_surface: [], internal_surface: [] },
          },
        }),
      },
      renderEnrichment: () => "",
    });

    await composer.composePrompt(packet, "Do work.");

    assert.equal(packet.budgets.fallback_reads_remaining, 1);
  });

  it("keeps remote issuance from raising local tool-policy grants", async () => {
    const packet = makePacket({
      recipient: "delegator",
      tool_policy: { allow_read: false, allow_write: false, allow_shell: false },
      budgets: { fallback_reads_remaining: 0 },
    });
    const composer = new RemoteComposer({
      client: {
        compile: async () => ({
          prompt_version: "test",
          user_prompt: "REMOTE USER",
          final_prompt: "REMOTE USER",
          handoff: { files: { files_to_modify: [], read_only_context: [] }, omitted_raw_source_files: [] },
          issuance: {
            source: "posse-remote",
            role: "delegator",
            provider: "claude",
            tool_policy: { allow_read: true, allow_write: true, allow_shell: true, fallback_reads: 3 },
            tool_surface: ["tools.read_file", "tools.write_file", "tools.shell"],
            atlas: { available: false, route_phase: "delegator", rationale: "test", agent_surface: [], prefetch_surface: [], internal_surface: [] },
          },
        }),
      },
      renderEnrichment: () => "",
    });

    await composer.composePrompt(packet, "Do work.");

    assert.deepEqual(packet.tool_policy, { allow_read: false, allow_write: false, allow_shell: false });
    assert.equal(packet.budgets.fallback_reads_remaining, 0);
  });

  it("reloads the active bundle when compile prompt_version differs", async () => {
    const warnings = [];
    setActivePromptBundleForTest(remotePromptBundleResponse({ prompt_version: "bundle-v1" }));
    try {
      const packet = makePacket();
      const composer = new RemoteComposer({
        client: {
          getPromptBundle: async () => remotePromptBundleResponse({ prompt_version: "compile-v2" }),
          compile: async () => ({
            prompt_version: "compile-v2",
            user_prompt: "REMOTE USER",
            final_prompt: "REMOTE USER",
            handoff: { files: { files_to_modify: [], read_only_context: [] }, omitted_raw_source_files: [] },
            issuance: {
              source: "posse-remote",
              role: "dev",
              provider: "claude",
              tool_policy: { allow_read: true, allow_write: true, allow_shell: false, fallback_reads: 3 },
              tool_surface: ["tools.read_file"],
              atlas: { available: false, route_phase: "dev", rationale: "test", agent_surface: [], prefetch_surface: [], internal_surface: [] },
            },
          }),
        },
        renderEnrichment: () => "",
        warn: (...args) => warnings.push(args),
      });

      const result = await composer.composePrompt(packet, "Do work.");

      assert.equal(warnings.length, 1);
      assert.equal(warnings[0][0], "posse-remote");
      assert.match(warnings[0][1], /Reloaded active prompt bundle/);
      assert.equal(getPromptBundleVersion(), "compile-v2");
      assert.equal(result.metadata.bundle_prompt_version, "compile-v2");
      assert.equal(result.metadata.prompt_version_skew, undefined);
      assert.deepEqual(packet.remote_prompt_bundle_reloaded, {
        previous_prompt_version: "bundle-v1",
        prompt_version: "compile-v2",
      });
    } finally {
      resetActivePromptBundleForTest();
    }
  });

  it("rejects prompts that exceed the post-enrichment prompt cap", async () => {
    const composer = new RemoteComposer({
      client: {
        compile: async () => ({
          prompt_version: "test",
          user_prompt: "REMOTE USER",
          final_prompt: "REMOTE USER",
          handoff: { files: { files_to_modify: [], read_only_context: [] }, omitted_raw_source_files: [] },
          issuance: {
            source: "posse-remote",
            role: "dev",
            provider: "claude",
            tool_policy: { allow_read: true, allow_write: true, allow_shell: true, fallback_reads: 3 },
            tool_surface: ["tools.read_file"],
            atlas: { available: false, route_phase: "dev", rationale: "test", agent_surface: [], prefetch_surface: [], internal_surface: [] },
          },
        }),
      },
      renderEnrichment: () => "LOCAL ".repeat(20),
    });

    await assert.rejects(
      () => composer.composePrompt(makePacket(), "Do work.", { maxPromptChars: 40 }),
      (err) => {
        assert.equal(err.code, "POSSE_PROMPT_TOO_LARGE");
        assert.equal(err.maxPromptChars, 40);
        return true;
      },
    );
  });

  it("calls remote compile for each prompt composition instead of caching issuance", async () => {
    let calls = 0;
    const composer = new RemoteComposer({
      client: {
        compile: async () => {
          calls += 1;
          return {
            prompt_version: "test",
            system_prompt: "REMOTE SYSTEM",
            stable_context: "REMOTE STABLE",
            user_prompt: `REMOTE USER ${calls}`,
            final_prompt: `REMOTE SYSTEM\n\nREMOTE STABLE\n\nREMOTE USER ${calls}`,
            handoff: { files: { files_to_modify: [], read_only_context: [] }, omitted_raw_source_files: [] },
            issuance: {
              source: "posse-remote",
              role: "dev",
              provider: "claude",
              tool_policy: { allow_read: true, allow_write: true, allow_shell: true, fallback_reads: 3 },
              tool_surface: ["tools.read_file"],
              atlas: { available: false, route_phase: "dev", rationale: "test", agent_surface: [], prefetch_surface: [], internal_surface: [] },
            },
            metadata: { prompt_chars: 15 },
          };
        },
      },
    });
    const packet = makePacket();

    const first = await composer.composePrompt(packet, "Do work.");
    const second = await composer.composePrompt(packet, "Do work.");

    assert.equal(calls, 2);
    assert.match(first.userPrompt, /REMOTE USER 1/);
    assert.match(second.userPrompt, /REMOTE USER 2/);
  });

  it("buildPromptAsync requires and uses remote prompts", async () => {
    const packet = makePacket();
    const prompt = await buildPromptAsync(packet, "Do work.", {
      composer: {
        composePrompt: async () => ({
          prompt: "REMOTE SYSTEM\n\nREMOTE STABLE\n\nREMOTE USER",
          systemPrompt: "REMOTE SYSTEM",
          stableContext: "REMOTE STABLE",
          userPrompt: "REMOTE USER",
          latencyMs: 7,
          metadata: { prompt_version: "test" },
          response: { system_prompt: "REMOTE SYSTEM", stable_context: "REMOTE STABLE", user_prompt: "REMOTE USER" },
        }),
      },
    });

    assert.equal(prompt, "REMOTE USER");
    assert.equal(packet.remote_prompt_composed, true);
    assert.equal(packet.remote_system_prompt, "REMOTE SYSTEM");
    assert.equal(packet.stable_context, "REMOTE STABLE");
    assert.equal(packet.posse_remote.source, "remote");
  });

  it("bounds remote prompt composition at the handoff layer", async () => {
    const previous = process.env.POSSE_HANDOFF_REMOTE_COMPILE_TIMEOUT_MS;
    process.env.POSSE_HANDOFF_REMOTE_COMPILE_TIMEOUT_MS = "20";
    try {
      const packet = makePacket();
      await assert.rejects(
        () => composePromptRemoteAware(packet, "Do work.", {
          composer: {
            composePrompt: async () => new Promise(() => {}),
          },
        }),
        (err) => {
          assert.equal(err.code, "POSSE_REMOTE_REQUIRED");
          assert.match(err.message, /timed out after 20ms/);
          assert.equal(packet.posse_remote.ok, false);
          return true;
        },
      );
    } finally {
      if (previous == null) delete process.env.POSSE_HANDOFF_REMOTE_COMPILE_TIMEOUT_MS;
      else process.env.POSSE_HANDOFF_REMOTE_COMPILE_TIMEOUT_MS = previous;
    }
  });

  it("does not render fallback-only atlas.file.read in handoff guidance", () => {
    const rendered = renderAtlasHandoffSections({
      recipient: "dev",
      atlas: {
        active: true,
        provider: "claude",
        transport: "mcp-gateway",
        phase: "dev",
        gateEnabled: true,
        tools: ["context", "file.read", "context.summary", "code.getSkeleton"],
        repo: { repoPath: process.cwd() },
      },
    });

    assert.doesNotMatch(rendered, /file\.read/);
    assert.match(rendered, /atlas\.context\.summary|atlas_context_summary/);
    assert.doesNotMatch(rendered, /atlas\.context:/);
    assert.match(rendered, /code\.getSkeleton|atlas_code_getSkeleton/);
  });

  it("remote-aware prompt composition fails closed without a routing packet", async () => {
    await assert.rejects(
      () => composePromptRemoteAware(null, "Do work."),
      (err) => err?.code === "POSSE_REMOTE_REQUIRED"
        && /requires a routing packet/.test(err.message),
    );
  });

  it("routes provider-side assessor ATLAS context through remote composition", async () => {
    let seenPacket = null;
    let seenInstructions = null;
    const result = await composeRemoteAssessorPromptForProvider("Assess this output.", {
      role: "assessor",
      providerName: "openai",
      workingDir: process.cwd(),
      activity: "assessing",
      scopedFiles: ["src/app.js"],
      atlasAttachment: { active: true },
      handoffFn: async (input) => ({
        recipient: input.recipient,
        job_type: "assessor",
        execution_provider: input.data.execution_provider,
        cwd: input.data.cwd,
        title: input.data.title,
        files_to_modify: input.data.files_to_modify,
        project_context: input.data.project_context,
        attempt: { count: 1, max: 1, last_error: null },
        atlas: { active: true, tools: ["pr.risk", "context"] },
      }),
      renderAtlasHandoffSectionsFn: () => "ATLAS ASSESSMENT BASELINE\nRisk: medium",
      composer: {
        composePrompt: async (packet, instructions, opts) => {
          seenPacket = packet;
          seenInstructions = instructions;
          assert.equal(opts.providerName, "openai");
          return {
            prompt: "REMOTE SYSTEM\n\nREMOTE STABLE\n\nREMOTE USER",
            systemPrompt: "REMOTE SYSTEM",
            stableContext: "REMOTE STABLE",
            userPrompt: "REMOTE USER",
            latencyMs: 3,
            metadata: { prompt_version: "test" },
            response: { system_prompt: "REMOTE SYSTEM", stable_context: "REMOTE STABLE", user_prompt: "REMOTE USER" },
          };
        },
      },
    });

    assert.equal(result.promptText, "REMOTE USER");
    assert.equal(result.remoteSystemPrompt, "REMOTE SYSTEM");
    assert.equal(result.stableContext, "REMOTE STABLE");
    assert.equal(seenInstructions, "Assess this output.");
    assert.equal(seenPacket.execution_provider, "openai");
    assert.equal(seenPacket.atlas.summary, "ATLAS ASSESSMENT BASELINE\nRisk: medium");
    assert.deepEqual(seenPacket.files_to_modify, ["src/app.js"]);
  });
});
