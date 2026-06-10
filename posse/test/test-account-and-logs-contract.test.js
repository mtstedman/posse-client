import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), "..");

describe("account + logs class contract", () => {
  it("keeps stateful account and log classes in domain/shared class paths", () => {
    const expected = [
      path.join(repoDir, "lib", "domains", "settings", "classes", "AccountSettings.js"),
      path.join(repoDir, "lib", "shared", "telemetry", "classes", "logging", "DatedRotatingLog.js"),
      path.join(repoDir, "lib", "shared", "telemetry", "classes", "logging", "OutputLog.js"),
      path.join(repoDir, "lib", "shared", "telemetry", "classes", "logging", "PromptLog.js"),
    ];
    for (const target of expected) {
      assert.equal(fs.existsSync(target), true, `missing class module: ${target}`);
    }
  });

  it("keeps function wrappers free of module-level mutable state", () => {
    const wrappers = [
      path.join(repoDir, "lib", "domains", "settings", "functions", "account-settings.js"),
      path.join(repoDir, "lib", "shared", "telemetry", "functions", "logging", "output-log.js"),
      path.join(repoDir, "lib", "shared", "telemetry", "functions", "logging", "prompt-log.js"),
    ];
    for (const wrapper of wrappers) {
      const source = fs.readFileSync(wrapper, "utf8");
      assert.doesNotMatch(source, /\blet\s+_/);
      assert.doesNotMatch(source, /\bconst\s+_fd\b/);
    }
  });

  it("preserves AccountSettings test seam and wrapper behavior", async () => {
    const { AccountSettings } = await import("../lib/domains/settings/classes/AccountSettings.js");
    const accountFns = await import("../lib/domains/settings/functions/account-settings.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-account-class-contract-"));
    const directDbPath = path.join(tmpDir, "direct-account.db");
    const wrappedDbPath = path.join(tmpDir, "wrapped-account.db");

    try {
      const direct = AccountSettings.forTests({ dbPath: directDbPath });
      direct.set("artifact_image_provider", "openai");
      assert.equal(direct.get("artifact_image_provider"), "openai");
      assert.equal(direct.getPathForDisplay(), path.resolve(directDbPath));
      direct.close();

      accountFns.setAccountSettingsPathForTests(wrappedDbPath);
      accountFns.setAccountSettings({ artifact_image_provider: "grok" });
      assert.equal(accountFns.getAccountSetting("artifact_image_provider"), "grok");
      accountFns.closeAccountSettingsDb();
      accountFns.setAccountSettingsPathForTests(null);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("honors POSSE_ACCOUNT_DB_PATH for the default account DB", async () => {
    const { AccountSettings } = await import("../lib/domains/settings/classes/AccountSettings.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-account-env-contract-"));
    const envDbPath = path.join(tmpDir, "env-account.db");
    const originalEnv = process.env.POSSE_ACCOUNT_DB_PATH;
    const settings = new AccountSettings();

    try {
      process.env.POSSE_ACCOUNT_DB_PATH = envDbPath;
      settings.set("artifact_image_provider", "openai");

      assert.equal(settings.get("artifact_image_provider"), "openai");
      assert.equal(settings.getPathForDisplay(), path.resolve(envDbPath));
      assert.equal(fs.existsSync(envDbPath), true);
    } finally {
      settings.close();
      if (originalEnv == null) delete process.env.POSSE_ACCOUNT_DB_PATH;
      else process.env.POSSE_ACCOUNT_DB_PATH = originalEnv;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("refreshes cached account settings after another process writes the DB", async () => {
    const { AccountSettings } = await import("../lib/domains/settings/classes/AccountSettings.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-account-cross-process-"));
    const dbPath = path.join(tmpDir, "account.db");
    const settings = AccountSettings.forTests({ dbPath });

    try {
      settings.set("artifact_image_provider", "openai");
      assert.equal(settings.get("artifact_image_provider"), "openai");

      const external = new Database(dbPath);
      try {
        external.pragma("journal_mode = WAL");
        external.prepare(
          `INSERT INTO account_settings (setting_key, setting_value, updated_at)
           VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT(setting_key) DO UPDATE
             SET setting_value = excluded.setting_value,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        ).run("artifact_image_provider", "grok");
      } finally {
        external.close();
      }

      assert.equal(settings.get("artifact_image_provider"), "grok");
    } finally {
      settings.close();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("records and reads prompt/output logs via class instances", async () => {
    const { PromptLog, promptPreviewText } = await import("../lib/shared/telemetry/classes/logging/PromptLog.js");
    const { OutputLog } = await import("../lib/shared/telemetry/classes/logging/OutputLog.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-logs-class-contract-"));

    try {
      const promptLog = new PromptLog({ dir: tmpDir });
      const outputLog = new OutputLog({ dir: tmpDir });

      assert.equal(
        promptLog.record({ job_id: 11, role: "planner", prompt: "TASK\nBuild plan\n" }),
        true,
      );
      assert.equal(
        outputLog.record({ job_id: 11, role: "planner", output: "Plan complete" }),
        true,
      );

      const prompts = promptLog.readRecent({ limit: 1, jobId: 11 });
      const outputs = outputLog.readRecent({ limit: 1, jobId: 11 });
      assert.equal(prompts.length, 1);
      assert.equal(outputs.length, 1);
      assert.equal(prompts[0].job_id, 11);
      assert.equal(outputs[0].job_id, 11);
      assert.match(promptPreviewText(prompts[0]), /TASK|Build plan/i);

      promptLog.close();
      outputLog.close();
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("scrubs secret-looking prompt/output log content by default and supports explicit opt-out", async () => {
    const { PromptLog } = await import("../lib/shared/telemetry/classes/logging/PromptLog.js");
    const { OutputLog } = await import("../lib/shared/telemetry/classes/logging/OutputLog.js");
    const { writeRuntimeLogAtDir } = await import("../lib/shared/telemetry/functions/logging/logger.js");
    const accountFns = await import("../lib/domains/settings/functions/account-settings.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-prompt-scrub-"));
    const runtimeLogDir = path.join(tmpDir, "runtime");
    const accountPath = path.join(tmpDir, "account.db");

    try {
      accountFns.setAccountSettingsPathForTests(accountPath);
      const promptLog = new PromptLog({ dir: tmpDir, persistContent: true });
      const outputLog = new OutputLog({ dir: tmpDir });
      const genericSecret = "123456789012345678901";
      const interiorEnvSecret = "ZYXWVUTSRQPONMLKJIHGFEDCBA";
      const openAiProjectKey = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
      const openAiRawKey = "sk-raw_abcdefghijklmnopqrstuvwxyz0123456789";
      promptLog.record({
        job_id: 12,
        role: "dev",
        prompt: [
          "before interior env secret",
          `SERVICE_ACCESS_TOKEN=${interiorEnvSecret}`,
          `API_KEY="${genericSecret}"`,
          `OPENAI_API_KEY=${openAiProjectKey}`,
          `raw=${openAiRawKey}`,
        ].join("\n"),
      });
      outputLog.record({
        job_id: 12,
        role: "dev",
        output: [
          "before interior env secret",
          `SERVICE_ACCESS_TOKEN=${interiorEnvSecret}`,
          `API_KEY="${genericSecret}"`,
          `OPENAI_API_KEY=${openAiProjectKey}`,
          `raw=${openAiRawKey}`,
        ].join("\n"),
        errorText: [
          `SECRET_KEY="${genericSecret}"`,
          openAiRawKey,
        ].join("\n"),
      });
      assert.equal(writeRuntimeLogAtDir(runtimeLogDir, "info", "test", "runtime payload", {
        raw: `before\nSERVICE_ACCESS_TOKEN=${interiorEnvSecret}\nafter`,
        authorization: `Bearer ${openAiRawKey}`,
      }), true);
      accountFns.setAccountSetting("posse_log_scrub_secrets", "false");
      promptLog.record({
        job_id: 13,
        role: "dev",
        prompt: `SERVICE_ACCESS_TOKEN=${interiorEnvSecret}\nAPI_KEY="${genericSecret}"\nOPENAI_API_KEY=${openAiProjectKey}`,
      });
      outputLog.record({
        job_id: 13,
        role: "dev",
        output: `SERVICE_ACCESS_TOKEN=${interiorEnvSecret}\nAPI_KEY="${genericSecret}"\nOPENAI_API_KEY=${openAiProjectKey}`,
        errorText: `SECRET_KEY="${genericSecret}"\n${openAiRawKey}`,
      });
      promptLog.close();
      outputLog.close();

      const scrubbedPrompts = promptLog.readRecent({ limit: 1, jobId: 13 });
      assert.equal(scrubbedPrompts.length, 1);
      assert.match(scrubbedPrompts[0].prompt, /123456789012345678901/);
      assert.match(scrubbedPrompts[0].prompt, /ZYXWVUTSRQPONMLKJIHGFEDCBA/);
      assert.match(scrubbedPrompts[0].prompt, /sk-proj-/);
      const scrubbedOutputs = outputLog.readRecent({ limit: 1, jobId: 13 });
      assert.equal(scrubbedOutputs.length, 1);
      assert.match(scrubbedOutputs[0].output, /123456789012345678901/);
      assert.match(scrubbedOutputs[0].output, /ZYXWVUTSRQPONMLKJIHGFEDCBA/);
      assert.match(scrubbedOutputs[0].error_text, /123456789012345678901/);
      assert.match(scrubbedOutputs[0].output, /sk-proj-/);
      assert.match(scrubbedOutputs[0].error_text, /sk-raw_/);

      const defaultPrompts = promptLog.readRecent({ limit: 1, jobId: 12 });
      assert.equal(defaultPrompts.length, 1);
      assert.match(defaultPrompts[0].prompt, /\[REDACTED:API key\/token assignment\]/);
      assert.doesNotMatch(defaultPrompts[0].prompt, /123456789012345678901/);
      assert.match(defaultPrompts[0].prompt, /\[REDACTED:Secret env variable\]/);
      assert.doesNotMatch(defaultPrompts[0].prompt, /ZYXWVUTSRQPONMLKJIHGFEDCBA/);
      assert.match(defaultPrompts[0].prompt, /\[REDACTED:OpenAI API key\]/);
      assert.doesNotMatch(defaultPrompts[0].prompt, /sk-proj-/);
      assert.doesNotMatch(defaultPrompts[0].prompt, /sk-raw_/);
      const defaultOutputs = outputLog.readRecent({ limit: 1, jobId: 12 });
      assert.equal(defaultOutputs.length, 1);
      assert.match(defaultOutputs[0].output, /\[REDACTED:API key\/token assignment\]/);
      assert.match(defaultOutputs[0].output, /\[REDACTED:Secret env variable\]/);
      assert.match(defaultOutputs[0].error_text, /\[REDACTED:API key\/token assignment\]/);
      assert.doesNotMatch(defaultOutputs[0].output, /123456789012345678901/);
      assert.doesNotMatch(defaultOutputs[0].output, /ZYXWVUTSRQPONMLKJIHGFEDCBA/);
      assert.doesNotMatch(defaultOutputs[0].error_text, /123456789012345678901/);
      assert.match(defaultOutputs[0].output, /\[REDACTED:OpenAI API key\]/);
      assert.match(defaultOutputs[0].error_text, /\[REDACTED:OpenAI API key\]/);
      assert.doesNotMatch(defaultOutputs[0].output, /sk-proj-/);
      assert.doesNotMatch(defaultOutputs[0].output, /sk-raw_/);
      assert.doesNotMatch(defaultOutputs[0].error_text, /sk-raw_/);

      const runtimeLogFile = fs.readdirSync(runtimeLogDir).find((name) => name.startsWith("posse-") && name.endsWith(".log"));
      assert.ok(runtimeLogFile);
      const runtimeLogText = fs.readFileSync(path.join(runtimeLogDir, runtimeLogFile), "utf8");
      assert.match(runtimeLogText, /\[REDACTED:Secret env variable\]/);
      assert.match(runtimeLogText, /\[REDACTED:OpenAI API key\]/);
      assert.doesNotMatch(runtimeLogText, /ZYXWVUTSRQPONMLKJIHGFEDCBA/);
      assert.doesNotMatch(runtimeLogText, /sk-raw_/);
    } finally {
      accountFns.closeAccountSettingsDb();
      accountFns.setAccountSettingsPathForTests(null);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("rotates dated logs through the shared base class and prunes old files", async () => {
    const { DatedRotatingLog } = await import("../lib/shared/telemetry/classes/logging/DatedRotatingLog.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-dated-log-"));
    const clock = () => new Date("2026-05-15T12:00:00.000Z");

    try {
      fs.writeFileSync(path.join(tmpDir, "events-2026-05-10.log"), "old\n", "utf8");
      fs.writeFileSync(path.join(tmpDir, "events-2026-05-14.log"), "recent\n", "utf8");
      const datedLog = new DatedRotatingLog({
        dir: tmpDir,
        filePrefix: "events-",
        retentionDays: 3,
        clock,
      });

      assert.equal(datedLog.write("{\"ok\":true}"), true);
      datedLog.close();

      assert.equal(fs.existsSync(path.join(tmpDir, "events-2026-05-10.log")), false);
      assert.equal(fs.existsSync(path.join(tmpDir, "events-2026-05-14.log")), true);
      assert.deepEqual(
        datedLog.readRecentEntries({ limit: 1, parseLine: JSON.parse }),
        [{ ok: true }],
      );
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
});
