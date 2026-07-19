// Read-only diagnostic CLI commands: `posse calls`, `posse prompts`,
// `posse usage`, `posse atlas-smoke`, `posse atlas`, `posse atlas-v2`, `posse codex-models`,
// `posse mcp-status`, `posse windows-events`. None of these mutate the queue or the worktree —
// they format snapshots of existing state.
//
// Each command takes an explicit deps bundle so orchestrator-app.js can
// pass through its module-private lazy loaders without this module
// reaching back into the CLI module for them.

import path from "path";
import { execFileSync } from "child_process";
import { C } from "../../../shared/format/functions/colors.js";
import { roleBrandColor, unlimitedCapacityGauge } from "../../ui/functions/display/helpers/brand.js";
import { getCommandPositionalArgs } from "./flags.js";
import { readRecentPrompts } from "../../../shared/telemetry/functions/logging/prompt-log.js";
import { getAgentCallStats, getResearcherGuardrailStats, getScopeContextHealthMetrics, getSetting, listAgentCalls } from "../../queue/functions/index.js";
import { buildAgentCallReplayPacket, formatReplayPacket } from "../../observability/functions/recovery/job-replay.js";
import { appendRunTelemetry, getRunTelemetryDir } from "../../../shared/telemetry/functions/run-telemetry.js";
import {
  getCurrentRunProviderUsage,
  getLatestRunStartedAtIso,
  getTodayProviderUsage,
} from "../../ui/functions/display/helpers/provider-usage.js";
import {
  buildProviderUsageDocument,
  serializeProviderUsageDocument,
} from "../../providers/functions/provider-usage-contract.js";

function fmtUsagePct(value) {
  if (value == null || value === "") return "?%";
  const n = Number(value);
  if (!Number.isFinite(n)) return "?%";
  return `${n.toFixed(n >= 10 ? 0 : 1)}%`;
}

function renderUsageBarByPct(pct, width = 18) {
  const safeWidth = Math.max(8, width | 0);
  if (pct == null || pct === "" || !Number.isFinite(Number(pct))) {
    return `${C.dim}[${"?".repeat(safeWidth)}]${C.reset}`;
  }
  const ratio = Math.max(0, Math.min(1, Number(pct || 0) / 100));
  const filled = Math.max(0, Math.min(safeWidth, Math.round(ratio * safeWidth)));
  const empty = Math.max(0, safeWidth - filled);
  const color = ratio >= 0.9 ? C.red : ratio >= 0.75 ? C.yellow : C.green;
  return `${C.dim}[${C.reset}${color}${"#".repeat(filled)}${C.dim}${".".repeat(empty)}${C.reset}${C.dim}]${C.reset}`;
}

function fmtRelativeUsageTime(isoString) {
  const ts = Date.parse(isoString);
  if (!Number.isFinite(ts)) return isoString || "";
  const diffMs = ts - Date.now();
  const totalMinutes = Math.round(Math.abs(diffMs) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const body = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return diffMs >= 0 ? `in ${body}` : `${body} ago`;
}

function cliFlagValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx < 0 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
}

function parseProbeMinutes(args) {
  const raw = cliFlagValue(args, "--minutes", cliFlagValue(args, "--window-minutes", "60"));
  const parsed = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 24 * 60) : 60;
}

function normalizeWindowsEventRows(rawJson) {
  const raw = String(rawJson || "").trim();
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    time_created: row.time_created || row.TimeCreated || null,
    log_name: row.log_name || row.LogName || null,
    provider_name: row.ProviderName || row.provider_name || null,
    event_id: Number(row.Id ?? row.event_id ?? 0) || null,
    level: row.LevelDisplayName || row.level || null,
    message: String(row.message || row.Message || "").replace(/\s+/g, " ").slice(0, 1200),
  }));
}

export function cmdCalls({ tierModelName }) {
  const rawArgs = process.argv.slice(3);
  const jsonOutput = rawArgs.includes("--json");
  const filterArg = getCommandPositionalArgs(rawArgs)[0] || null;
  const fmtTok = (n) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n || 0);

  // ── Aggregate stats ────────────────────────────────────────────────────
  const stats = getAgentCallStats();
  const researcherGuardrails = getResearcherGuardrailStats();
  const scopeContextHealth = getScopeContextHealthMetrics({ trailingDays: 7 });
  const recent = filterArg
    ? listAgentCalls({ role: filterArg, limit: 20 })
    : listAgentCalls({ limit: 20 });
  const totals = stats.reduce((acc, row) => {
    acc.call_count += row.call_count || 0;
    acc.total_duration_ms += row.total_duration_ms || 0;
    acc.total_prompt_chars += row.total_prompt_chars || 0;
    acc.total_output_chars += row.total_output_chars || 0;
    acc.total_input_tokens += row.total_input_tokens || 0;
    acc.total_cached_input_tokens += row.total_cached_input_tokens || 0;
    acc.total_output_tokens += row.total_output_tokens || 0;
    acc.total_turns_used += row.total_turns_used || 0;
    acc.output_truncated_count += row.output_truncated_count || 0;
    return acc;
  }, {
    call_count: 0,
    total_duration_ms: 0,
    total_prompt_chars: 0,
    total_output_chars: 0,
    total_input_tokens: 0,
    total_cached_input_tokens: 0,
    total_output_tokens: 0,
    total_turns_used: 0,
    output_truncated_count: 0,
  });

  if (jsonOutput) {
    console.log(JSON.stringify({
      filter_role: filterArg,
      totals,
      stats,
      researcher_guardrails: researcherGuardrails,
      scope_context_health: scopeContextHealth,
      recent,
    }, null, 2));
    return { filter_role: filterArg, totals, stats, researcher_guardrails: researcherGuardrails, scope_context_health: scopeContextHealth, recent };
  }

  if (stats.length === 0) {
    console.log(`\n  No agent calls recorded yet. Run 'go' or 'run' first.\n`);
    return;
  }

  console.log(`\n  ${C.bold}Agent Call Performance${C.reset}\n`);

  // Summary table
  let totalCalls = 0, totalMs = 0, totalPrompt = 0, totalOutput = 0, totalInTok = 0, totalCachedInTok = 0, totalOutTok = 0;

  console.log(`  ${C.dim}${"Role".padEnd(12)} ${"Tier".padEnd(10)} ${"Calls".padStart(6)} ${"Succeeded".padStart(10)} ${"Failed".padStart(7)} ${"Total Time".padStart(11)} ${"Avg Time".padStart(9)} ${"Prompt KB".padStart(10)} ${"Output KB".padStart(10)} ${"In Tok".padStart(9)} ${"Cached".padStart(9)} ${"Out Tok".padStart(9)}${C.reset}`);
  console.log(`  ${C.dim}${"─".repeat(123)}${C.reset}`);

  for (const row of stats) {
    const color = roleBrandColor(row.role);
    const totalSec = row.total_duration_ms ? (row.total_duration_ms / 1000).toFixed(1) : "0";
    const avgSec = row.avg_duration_ms ? (row.avg_duration_ms / 1000).toFixed(1) : "0";
    const promptKb = row.total_prompt_chars ? (row.total_prompt_chars / 1024).toFixed(1) : "0";
    const outputKb = row.total_output_chars ? (row.total_output_chars / 1024).toFixed(1) : "0";
    const inTok = row.total_input_tokens ? fmtTok(row.total_input_tokens) : "—";
    const cachedTok = row.total_cached_input_tokens ? fmtTok(row.total_cached_input_tokens) : "—";
    const outTok = row.total_output_tokens ? fmtTok(row.total_output_tokens) : "—";

    console.log(
      `  ${color}${row.role.padEnd(12)}${C.reset} ${tierModelName(row.model_tier, { role: row.role }).padEnd(10)} ` +
      `${String(row.call_count).padStart(6)} ` +
      `${C.green}${String(row.succeeded).padStart(10)}${C.reset} ` +
      `${row.failed > 0 ? C.red : C.dim}${String(row.failed).padStart(7)}${C.reset} ` +
      `${(totalSec + "s").padStart(11)} ` +
      `${(avgSec + "s").padStart(9)} ` +
      `${promptKb.padStart(10)} ` +
      `${outputKb.padStart(10)} ` +
      `${inTok.padStart(9)} ` +
      `${cachedTok.padStart(9)} ` +
      `${outTok.padStart(9)}`
    );

    totalCalls += row.call_count;
    totalMs += row.total_duration_ms || 0;
    totalPrompt += row.total_prompt_chars || 0;
    totalOutput += row.total_output_chars || 0;
    totalInTok += row.total_input_tokens || 0;
    totalCachedInTok += row.total_cached_input_tokens || 0;
    totalOutTok += row.total_output_tokens || 0;
  }

  console.log(`  ${C.dim}${"─".repeat(123)}${C.reset}`);
  console.log(
    `  ${C.bold}${"TOTAL".padEnd(23)}${C.reset} ` +
    `${String(totalCalls).padStart(6)} ` +
    `${"".padStart(10)} ${"".padStart(7)} ` +
    `${((totalMs / 1000).toFixed(1) + "s").padStart(11)} ` +
    `${((totalCalls > 0 ? totalMs / totalCalls / 1000 : 0).toFixed(1) + "s").padStart(9)} ` +
    `${(totalPrompt / 1024).toFixed(1).padStart(10)} ` +
    `${(totalOutput / 1024).toFixed(1).padStart(10)} ` +
    `${fmtTok(totalInTok).padStart(9)} ` +
    `${fmtTok(totalCachedInTok).padStart(9)} ` +
      `${fmtTok(totalOutTok).padStart(9)}`
  );
  const avgTurns = totalCalls > 0 ? (totals.total_turns_used / totalCalls).toFixed(1) : "0.0";
  console.log(
    `  ${C.dim}turns:${fmtTok(totals.total_turns_used)} avg:${avgTurns}/call ` +
    `output-caps-hit:${fmtTok(totals.output_truncated_count)}${C.reset}`
  );

  if (researcherGuardrails.totals.call_count > 0) {
    const g = researcherGuardrails.totals;
    const cachePct = g.input_tokens > 0 ? ((g.cached_input_tokens || 0) / g.input_tokens) * 100 : 0;
    const cost = Number(g.cost_usd || 0);
    console.log(`\n  ${C.bold}Researcher Guardrails${C.reset}`);
    console.log(
      `  jobs:${String(g.jobs).padStart(3)} ` +
      `${C.green}succeeded:${String(g.succeeded_jobs).padStart(3)}${C.reset} ` +
      `${g.failed_jobs > 0 ? C.red : C.dim}failed:${String(g.failed_jobs).padStart(3)}${C.reset} ` +
      `calls:${String(g.call_count).padStart(3)} ` +
      `in:${fmtTok(g.input_tokens).padStart(7)} ` +
      `cached:${fmtTok(g.cached_input_tokens).padStart(7)} (${fmtUsagePct(cachePct)}) ` +
      `cost:$${cost.toFixed(cost >= 10 ? 2 : 4)}`
    );
    console.log(
      `  evidence:${String(g.evidence_count).padStart(3)} ` +
      `novel:${String(g.novel_relevant_files).padStart(3)} ` +
      `synthesize-now:${String(g.synthesis_required_count).padStart(3)} ${C.dim}` +
      `(compare per-job tokens/cost with pass/fail in --json)${C.reset}`
    );
  }

  const contextTrailing = scopeContextHealth.trailing || {};
  const contextTotal = Object.values(contextTrailing).reduce((sum, value) => sum + (Number(value) || 0), 0);
  if (contextTotal > 0) {
    console.log(`\n  ${C.bold}Context Health${C.reset} ${C.dim}(last ${scopeContextHealth.trailing_days}d)${C.reset}`);
    console.log(
      `  trims:${String(contextTrailing.context_trimmed_packets || 0).padStart(3)} ` +
      `under-scoped:${String(contextTrailing.under_scoped_drops || 0).padStart(3)} ` +
      `recoveries:${String(contextTrailing.recovery_escalations || 0).padStart(3)} ` +
      `scope-noops:${String(contextTrailing.scope_cleaned_noops || 0).padStart(3)} ` +
      `shadow-conflicts:${String(contextTrailing.strict_shadow_conflicts || 0).padStart(3)}`
    );
  }

  // ── Recent calls detail ────────────────────────────────────────────────
  if (recent.length > 0) {
    console.log(`\n  ${C.bold}Recent Calls${filterArg ? ` (${filterArg})` : ""}${C.reset}\n`);

    for (const call of recent.reverse()) {
      const color = roleBrandColor(call.role);
      const dur = call.duration_ms ? (call.duration_ms / 1000).toFixed(1) + "s" : "...";
      const statusIcon = call.status === "succeeded" ? `${C.green}+` :
                         call.status === "failed" ? `${C.red}x` :
                         `${C.yellow}~`;
      const time = call.started_at?.split("T")[1]?.slice(0, 8) || "";
      const jobRef = call.job_id ? `#${call.job_id}` : "";
      const promptK = call.prompt_chars ? `${(call.prompt_chars / 1024).toFixed(0)}K` : "";
      const outputK = call.output_chars ? `${(call.output_chars / 1024).toFixed(0)}K` : "";
      const turns = call.turns_used != null ? ` turns:${call.turns_used}` : "";
      const capHit = call.output_truncated ? ` ${C.yellow}cap:${call.output_limit_reason || "hit"}${C.reset}` : "";

      console.log(
        `  ${C.dim}${time}${C.reset} ${statusIcon}${C.reset} ` +
        `${color}${call.role.padEnd(12)}${C.reset} ` +
        `${C.dim}${tierModelName(call.model_tier, { providerName: call.provider }).padEnd(9)}${C.reset} ` +
        `${jobRef.padEnd(5)} ` +
        `${dur.padStart(7)} ` +
        `${C.dim}in:${promptK.padEnd(5)} out:${outputK.padEnd(5)}${turns}${C.reset}${capHit} ` +
        `${call.activity || ""}`
      );
    }
  }

  console.log();
}

export function cmdPrompts() {
  const args = process.argv.slice(3);
  let jobId = null, role = null, limit = 20, fullPrompt = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--full") fullPrompt = true;
    else if (a === "--job" || a === "-j") jobId = parseInt(args[++i], 10);
    else if (a === "--role" || a === "-r") role = args[++i];
    else if (a === "--limit" || a === "-n") limit = parseInt(args[++i], 10) || 20;
    else if (!a.startsWith("-") && /^\d+$/.test(a)) jobId = parseInt(a, 10);
  }

  const records = readRecentPrompts({ limit, jobId, role });
  if (records.length === 0) {
    console.log(`\n  No prompts recorded${jobId ? ` for job #${jobId}` : ""}${role ? ` (role=${role})` : ""}.\n`);
    console.log(`  ${C.dim}Prompts are logged to .posse/logs/prompts-YYYY-MM-DD.log when agents run (3-day retention).${C.reset}\n`);
    return;
  }

  console.log(`\n  ${C.bold}Recent Agent Prompts${C.reset} ${C.dim}(showing ${records.length})${C.reset}\n`);

  for (const r of records) {
    const when = r.ts || "";
    const color = roleBrandColor(r.role);
    const kb = r.prompt_chars ? `${(r.prompt_chars / 1024).toFixed(1)}KB` : "?";
    console.log(
      `  ${C.dim}${when}${C.reset}  ${color}${(r.role || "?").padEnd(10)}${C.reset}` +
      `  job ${C.bold}#${r.job_id ?? "?"}${C.reset}` +
      `  WI#${r.work_item_id ?? "?"}` +
      `  ${C.dim}${r.provider || "?"}/${r.model || r.model_tier || "?"}${C.reset}` +
      `  ${C.dim}${kb}${C.reset}` +
      (r.activity ? `  ${C.dim}${r.activity}${C.reset}` : "")
    );
    if (fullPrompt) {
      console.log(`    ${C.dim}${"─".repeat(78)}${C.reset}`);
      const prompt = String(r.prompt || "");
      for (const line of prompt.split("\n")) {
        console.log(`    ${line}`);
      }
      console.log(`    ${C.dim}${"─".repeat(78)}${C.reset}\n`);
    }
  }

  if (!fullPrompt) {
    console.log(`\n  ${C.dim}Use --full to print prompt bodies, --job <id> to filter, --role <name> to filter, --limit <n> (default 20).${C.reset}\n`);
  }
}

export function cmdReplay() {
  const args = process.argv.slice(3);
  const flags = new Set(args.filter((arg) => String(arg).startsWith("--")).map((arg) => String(arg).toLowerCase()));
  const positional = getCommandPositionalArgs(args);
  if (args.includes("--help") || args.includes("-h") || positional.length === 0) {
    console.log(`
  Usage: posse replay <agent-call-id> [--json] [--exact-prompt]

  Builds a replay packet for a provider call from durable queue records,
  prompt/output metadata, and compressed tool observations. Prompt bodies are
  excluded by default; --exact-prompt only works while the prompt is still
  retained in memory or when prompt logging was explicitly configured to
  persist prompt content.
`);
    return null;
  }

  const agentCallId = Number.parseInt(String(positional[0]).replace(/^call[:#-]?/i, ""), 10);
  if (!Number.isFinite(agentCallId) || agentCallId <= 0) {
    console.log(`\n  ${C.red}Invalid agent-call-id: ${positional[0]}${C.reset}\n`);
    return null;
  }

  try {
    const packet = buildAgentCallReplayPacket({
      agentCallId,
      exactPrompt: flags.has("--exact-prompt"),
    });
    if (flags.has("--json")) {
      process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
    } else {
      process.stdout.write(`\n${formatReplayPacket(packet)}\n`);
      if (!packet.prompt?.exact_prompt_included) {
        console.log(`  ${C.dim}Prompt body omitted. Use --exact-prompt only when explicit prompt replay is intended and available.${C.reset}\n`);
      }
    }
    return packet;
  } catch (err) {
    console.log(`\n  ${C.red}Replay failed:${C.reset} ${err.message}\n`);
    return null;
  }
}

export function cmdWindowsEvents({
  args = process.argv.slice(3),
  platform = process.platform,
  execFileSyncFn = execFileSync,
  stdout = console.log,
} = {}) {
  const jsonOutput = args.includes("--json");
  const minutes = parseProbeMinutes(args);
  const positional = getCommandPositionalArgs(args);
  const aroundRaw = cliFlagValue(args, "--around", positional[0] || null);
  const aroundMs = Number.isFinite(Date.parse(aroundRaw || "")) ? Date.parse(aroundRaw) : Date.now();
  const start = new Date(aroundMs - minutes * 60_000);
  const end = new Date(aroundMs + minutes * 60_000);
  const runDir = getRunTelemetryDir();

  if (platform !== "win32") {
    const result = {
      ok: false,
      skipped: true,
      reason: "windows_event_log_unavailable_on_this_platform",
      platform,
      run_dir: runDir,
    };
    appendRunTelemetry("diagnostics", { kind: "windows_event_probe.skipped", ...result });
    if (jsonOutput) stdout(JSON.stringify(result, null, 2));
    else stdout(`\n  Windows event-log probe is only available on Windows. Run dir: ${runDir}\n`);
    return result;
  }

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$start = [datetime]::Parse($env:POSSE_WIN_EVENT_START)
$end = [datetime]::Parse($env:POSSE_WIN_EVENT_END)
$providerPattern = 'Resource-Exhaustion|Application Error|Windows Error Reporting|Kernel-Power|Power-Troubleshooter|Kernel-General'
$ids = @(41, 42, 107, 109, 1000, 1001, 2004)
$events = @()
foreach ($logName in @('System','Application')) {
  $events += Get-WinEvent -FilterHashtable @{ LogName = $logName; StartTime = $start; EndTime = $end } -ErrorAction SilentlyContinue |
    Where-Object { ($_.ProviderName -match $providerPattern) -or ($ids -contains $_.Id) } |
    Select-Object @{Name='time_created';Expression={$_.TimeCreated.ToString('o')}}, @{Name='log_name';Expression={$_.LogName}}, ProviderName, Id, LevelDisplayName, Message
}
$events | Sort-Object time_created | ConvertTo-Json -Depth 4
`.trim();

  let raw = "";
  try {
    raw = execFileSyncFn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ], {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        POSSE_WIN_EVENT_START: start.toISOString(),
        POSSE_WIN_EVENT_END: end.toISOString(),
      },
      maxBuffer: 1024 * 1024 * 8,
    });
  } catch (err) {
    const result = {
      ok: false,
      skipped: false,
      run_dir: runDir,
      start: start.toISOString(),
      end: end.toISOString(),
      error: String(err?.message || err).slice(0, 1000),
    };
    appendRunTelemetry("diagnostics", { kind: "windows_event_probe.error", ...result });
    if (jsonOutput) stdout(JSON.stringify(result, null, 2));
    else stdout(`\n  ${C.red}Windows event probe failed:${C.reset} ${result.error}\n  Run dir: ${runDir}\n`);
    return result;
  }

  const events = normalizeWindowsEventRows(raw);
  for (const event of events) {
    appendRunTelemetry("windows-events", {
      probe_start_at: start.toISOString(),
      probe_end_at: end.toISOString(),
      ...event,
    });
  }
  const result = {
    ok: true,
    run_dir: runDir,
    start: start.toISOString(),
    end: end.toISOString(),
    count: events.length,
    events,
  };
  appendRunTelemetry("diagnostics", {
    kind: "windows_event_probe",
    run_dir: runDir,
    start: result.start,
    end: result.end,
    count: result.count,
  });

  if (jsonOutput) {
    stdout(JSON.stringify(result, null, 2));
    return result;
  }

  stdout(`\n  ${C.bold}Windows Event Probe${C.reset} ${C.dim}(${result.start} to ${result.end})${C.reset}`);
  stdout(`  Matching events: ${C.bold}${events.length}${C.reset}`);
  stdout(`  Run dir: ${C.dim}${runDir}${C.reset}`);
  for (const event of events.slice(-12)) {
    const msg = event.message ? ` ${C.dim}${event.message.slice(0, 140)}${C.reset}` : "";
    stdout(`  ${event.time_created || ""} ${event.log_name || ""} ${event.provider_name || ""} #${event.event_id || "?"} ${event.level || ""}${msg}`);
  }
  stdout("");
  return result;
}

export async function cmdUsage({
  projectDir,
  loadProviderModule,
  args = process.argv.slice(3),
  stdout = null,
  stderr = null,
  now = () => new Date(),
  getRunStartedAt = getLatestRunStartedAtIso,
  getCurrentRunUsage = getCurrentRunProviderUsage,
  getTodayUsage = getTodayProviderUsage,
  readSetting = (key) => getSetting(key, { projectDir }),
} = {}) {
  const jsonOutput = args.includes("--json");
  const refreshRequested = args.includes("--refresh") || args.includes("--force-refresh");
  const ignoreBackoff = args.includes("--force-refresh");
  const writeStdout = typeof stdout === "function"
    ? stdout
    : (value) => process.stdout.write(String(value));
  const writeStderr = typeof stderr === "function"
    ? stderr
    : (value) => process.stderr.write(String(value));
  const logLine = (value = "") => {
    if (typeof stdout === "function") stdout(`${value}\n`);
    else console.log(value);
  };
  const providerErrors = [];
  const { getConfiguredProviderUsage, getConfiguredProviderUsageAsync } = await loadProviderModule();
  const summaries = refreshRequested
    ? await getConfiguredProviderUsageAsync({
        cwd: projectDir,
        forceRefresh: true,
        ignoreBackoff,
        timeoutMs: 5_000,
        onError: (provider) => providerErrors.push(String(provider || "unknown")),
      })
    : getConfiguredProviderUsage({
        cwd: projectDir,
        onError: (provider) => providerErrors.push(String(provider || "unknown")),
      });
  for (const provider of providerErrors) {
    writeStderr(`posse usage: ${provider} usage unavailable\n`);
  }

  if (jsonOutput) {
    const generatedAt = now();
    const runStartedAt = getRunStartedAt();
    const document = buildProviderUsageDocument({
      summaries,
      currentRunUsage: runStartedAt ? getCurrentRunUsage({ runStartedAtIso: runStartedAt }) : [],
      todayUsage: getTodayUsage({ nowDate: generatedAt }),
      runStartedAt,
      generatedAt,
      readSetting,
    });
    writeStdout(serializeProviderUsageDocument(document));
    return document;
  }

  if (!summaries.length) {
    logLine("\n  No provider usage data available.\n");
    return;
  }

  logLine(`\n  ${C.bold}Provider Usage${C.reset}\n`);
  for (const summary of summaries) {
    const meta = [summary.subscriptionType, summary.rateLimitTier].filter(Boolean).join(" / ");
    logLine(`  ${C.bold}${summary.provider}${C.reset}${meta ? ` ${C.dim}(${meta})${C.reset}` : ""} ${C.dim}[${summary.source || "unknown"}]${C.reset}`);
    for (const window of summary.windows || []) {
      if (window.unlimited === true) {
        const gauge = unlimitedCapacityGauge({ width: 18 });
        logLine(`    ${window.label.padEnd(18)} ${gauge.bar} ${gauge.pctText}`);
        continue;
      }
      if (window.usageUnit === "currency") {
        const used = Number.isFinite(window.usedAmount) ? `$${window.usedAmount.toFixed(2)}` : "?";
        const limit = Number.isFinite(window.limitAmount) ? `$${window.limitAmount.toFixed(2)}` : "?";
        logLine(`    ${window.label.padEnd(18)} ${used} / ${limit}${window.enabled ? "" : ` ${C.dim}(disabled)${C.reset}`}`);
        continue;
      }

      const pct = Number.isFinite(window.utilizationPct)
        ? window.utilizationPct
        : (window.limitTokens > 0 ? ((window.usedTokens || 0) / window.limitTokens) * 100 : null);
      const usageText = window.limitTokens != null
        ? `${(window.usedTokens || 0).toLocaleString()} / ${window.limitTokens.toLocaleString()} tokens`
        : Number.isFinite(window.usedTokens)
          ? `${window.usedTokens.toLocaleString()} tokens observed`
        : `${fmtUsagePct(pct)} used`;
      const resetText = window.resetAt ? ` ${C.dim}| next drop ${fmtRelativeUsageTime(window.resetAt)}${C.reset}` : "";
      logLine(`    ${window.label.padEnd(18)} ${renderUsageBarByPct(pct)} ${fmtUsagePct(pct).padStart(6)} ${C.dim}|${C.reset} ${usageText}${resetText}`);
    }
    logLine("");
  }
}

export async function cmdAtlasSmoke({ projectDir }) {
  const args = getCommandPositionalArgs(process.argv.slice(3));
  const repoPath = args[0] ? path.resolve(args[0]) : projectDir;
  const query = args[1] || "main";
  const provider = args[2] || "openai";

  const atlasSmokeModule = await import("../../integrations/functions/atlas-smoke.js");
  const { runAtlasSmokeTest } = atlasSmokeModule;
  const report = await runAtlasSmokeTest({
    repoPath,
    query,
    provider,
  });

  const configuredRepoCount = report.configuredRepos.length;
  const repoConfigured = !!report.configuredRepo;
  const readyText = report.capability.ready ? `${C.green}ready${C.reset}` : `${C.yellow}not-ready${C.reset}`;
  const supportText = report.providerSupport.supported
    ? `${C.green}${report.providerSupport.transport}${C.reset}`
    : `${C.red}unsupported${C.reset}`;

  console.log(`\n  ${C.bold}ATLAS Smoke Test${C.reset}`);
  console.log(`  Repo: ${report.capability.repo.repoId || "(unknown)"} ${C.dim}${report.capability.repo.repoPath || ""}${C.reset}`);
  console.log(`  Provider: ${report.provider} ${C.dim}(${supportText})${C.reset}`);
  console.log(`  Role: ${report.role}`);
  console.log(`  Configured repos: ${configuredRepoCount}${repoConfigured ? ` ${C.green}[matched]${C.reset}` : ` ${C.yellow}[not matched]${C.reset}`}`);
  console.log(`  Capability: ${readyText}`);
  console.log(`  Query: ${query}`);

  if (!repoConfigured) {
    console.log(`  ${C.yellow}Warning:${C.reset} repo is not registered in ATLAS config, so lookups may fail until it is added.`);
  }

  console.log(`\n  ${C.bold}symbol.search${C.reset}\n`);
  console.log(String(report.symbolSearch || "").trim() || "(no output)");
  console.log(`\n  ${C.bold}atlas.context${C.reset}\n`);
  console.log(String(report.context || "").trim() || "(no output)");
  console.log("");
  return report;
}

export async function cmdAtlasV2({ projectDir }) {
  const { runAtlasV2Command } = await import("./commands/atlas-v2.js");
  const argv = process.argv.slice(3);
  return runAtlasV2Command({ projectDir, argv });
}

export async function cmdAtlas({ projectDir }) {
  console.log(`\n  ${C.bold}posse atlas${C.reset} — Atlas admin commands`);
  console.log(`\n  Atlas mutations are system-owned. Use ${C.cyan}posse atlas-v2${C.reset} for read-only diagnostics and warmer queue inspection.\n`);
  return null;
}

export async function cmdCodexModels({ projectDir }) {
  const args = getCommandPositionalArgs(process.argv.slice(3));
  const subcommand = String(args[0] || "validate").trim().toLowerCase();
  const authMode = String(args[1] || "oauth").trim().toLowerCase();

  if (!["validate", "list"].includes(subcommand)) {
    console.log("\n  Usage: posse codex-models [validate|list] [oauth|api|auto]\n");
    return null;
  }

  const {
    validateCodexModels,
    formatCodexModelValidationReport,
    getCurrentCodexModels,
  } = await import("../../providers/functions/codex/model-validator.js");

  if (subcommand === "list") {
    const models = getCurrentCodexModels({ includeKnown: true });
    console.log(`\n  ${C.bold}Codex Models (current candidates)${C.reset}`);
    for (const model of models) {
      console.log(`  - ${model}`);
    }
    console.log("");
    return { models };
  }

  const report = validateCodexModels({
    authMode,
    cwd: projectDir,
  });
  console.log("");
  console.log(formatCodexModelValidationReport(report));
  console.log("");
  return report;
}

export async function cmdMcpStatus({ projectDir, loadAtlasModule }) {
  const { getAtlasIntegrationConfig, probeAtlasGraphReadiness } = await loadAtlasModule();
  const config = getAtlasIntegrationConfig();
  const status = await probeAtlasGraphReadiness({ cwd: projectDir, config });
  console.log(`\n  ${C.bold}MCP Runtime Status${C.reset}`);
  console.log(`  ATLAS backend: v2 native`);
  console.log(`  Configured: ${config.enabled ? `${C.green}yes${C.reset}` : `${C.yellow}no${C.reset}`}`);
  console.log(`  Ready: ${status.usable ? `${C.green}yes${C.reset}` : `${C.yellow}no${C.reset}`}`);
  if (status.reason) console.log(`  Reason: ${status.reason}`);
  if (status.graphDbPath) console.log(`  Ledger DB: ${status.graphDbPath}`);
  if (status.viewDbPath) console.log(`  View DB: ${status.viewDbPath}`);
  console.log("");
  return status;
}
