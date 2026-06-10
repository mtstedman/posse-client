import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

let providerModules;

const ALL_PROVIDERS = ["claude", "openai", "grok", "codex", "copilot"];
const TOOL_ATTACHMENT_VALUES = new Set(["mcp", "function", "deterministic-bridge", null]);

describe("ProviderCapabilities contract", () => {
  before(async () => {
    // Import provider modules directly (not via provider.js / getProvider)
    // so the contract check stays a fast static-import test and never
    // triggers any provider runtime initialization.
    providerModules = {
      claude: await import("../lib/domains/providers/functions/claude.js"),
      openai: await import("../lib/domains/providers/functions/openai.js"),
      grok: await import("../lib/domains/providers/functions/grok.js"),
      codex: await import("../lib/domains/providers/functions/codex.js"),
      copilot: await import("../lib/domains/providers/functions/copilot.js"),
    };
  });

  it("every provider declares toolAttachment capability", () => {
    const expected = {
      claude: "mcp",
      openai: "function",
      grok: "function",
      codex: "deterministic-bridge",
      copilot: "mcp",
    };
    for (const name of ALL_PROVIDERS) {
      const cap = providerModules[name].capabilities;
      assert.ok(TOOL_ATTACHMENT_VALUES.has(cap.toolAttachment), `${name}.capabilities.toolAttachment must be one of ${[...TOOL_ATTACHMENT_VALUES]}`);
      assert.equal(cap.toolAttachment, expected[name], `${name}.toolAttachment expected ${expected[name]}, got ${cap.toolAttachment}`);
    }
  });

  it("openai and grok report their credential env vars", () => {
    assert.deepEqual(providerModules.openai.getCredentialEnvVars(), ["OPENAI_API_KEY"]);
    assert.deepEqual(providerModules.grok.getCredentialEnvVars(), ["XAI_API_KEY"]);
  });

  it("claude and codex report no env-var credentials (CLI / OAuth)", () => {
    // These providers may omit getCredentialEnvVars entirely; BaseProvider
    // falls back to []. Direct module export is optional for them.
    const claudeVars = typeof providerModules.claude.getCredentialEnvVars === "function"
      ? providerModules.claude.getCredentialEnvVars()
      : [];
    const codexVars = typeof providerModules.codex.getCredentialEnvVars === "function"
      ? providerModules.codex.getCredentialEnvVars()
      : [];
    assert.deepEqual(claudeVars, []);
    assert.deepEqual(codexVars, []);
  });

  it("image-capable providers expose buildImageClient; others do not", () => {
    assert.equal(typeof providerModules.openai.buildImageClient, "function");
    assert.equal(typeof providerModules.grok.buildImageClient, "function");
    assert.equal(typeof providerModules.claude.buildImageClient, "undefined");
    assert.equal(typeof providerModules.codex.buildImageClient, "undefined");
  });

  it("buildImageClient throws a clear error when credentials are missing", () => {
    const savedOpenAi = process.env.OPENAI_API_KEY;
    const savedXai = process.env.XAI_API_KEY;
    try {
      delete process.env.OPENAI_API_KEY;
      delete process.env.XAI_API_KEY;
      assert.throws(
        () => providerModules.openai.buildImageClient(),
        /OPENAI_API_KEY is required/,
      );
      assert.throws(
        () => providerModules.grok.buildImageClient(),
        /XAI_API_KEY is required/,
      );
    } finally {
      if (savedOpenAi !== undefined) process.env.OPENAI_API_KEY = savedOpenAi;
      if (savedXai !== undefined) process.env.XAI_API_KEY = savedXai;
    }
  });

  it("sessionResume capability is declared correctly per provider", () => {
    const expected = { claude: true, openai: true, grok: false, codex: true, copilot: false };
    for (const name of ALL_PROVIDERS) {
      assert.equal(providerModules[name].capabilities.sessionResume, expected[name], `${name}.capabilities.sessionResume`);
    }
  });

  it("TOOL_ATTACHMENT_BY_PROVIDER table matches each provider's capabilities", async () => {
    // tool-descriptors.js keeps a static table to avoid an import cycle with
    // provider.js. This drift check ensures the table tracks each provider's
    // self-declared capability so the two sources cannot diverge silently.
    const { TOOL_ATTACHMENT_BY_PROVIDER } = await import("../lib/domains/integrations/functions/deterministic-mcp/tool-descriptors.js");
    for (const name of ALL_PROVIDERS) {
      assert.equal(
        TOOL_ATTACHMENT_BY_PROVIDER[name],
        providerModules[name].capabilities.toolAttachment,
        `tool-descriptors TOOL_ATTACHMENT_BY_PROVIDER[${name}] must match providers/${name}.capabilities.toolAttachment`,
      );
    }
  });
});
