import { C } from "../../../shared/format/functions/colors.js";
import {
  formatSignedTokens,
  formatTokens as formatCostTokens,
  formatUsd,
} from "../../../shared/format/functions/units.js";
import {
  aggregateSessionRecycleSavings,
  getWorkItem,
  listSessionLanes,
} from "../../queue/functions/index.js";
import { buildTimeline } from "../../observability/functions/timeline/index.js";
import { renderTimelineJson, renderTimelineText } from "../../observability/functions/timeline/render.js";
import {
  aggregateCost,
  topWorkItemCosts,
  workItemCost,
} from "../../billing/functions/cost.js";
import {
  listDefaultPricing,
  listPricing,
  setPricing,
} from "../../billing/functions/pricing.js";
import { buildResearchFanoutReport } from "../../research/functions/fanout-report.js";

export function runTimelineCommand(args = []) {
  const wiArg = String(args[0] || "").trim();
  if (!wiArg || wiArg === "--help" || wiArg === "-h") {
    console.log(`
  Usage: posse timeline <wi-id> [--json] [--verbose]

  Renders the full execution chain for a work item: every job with its
  attempts, agent calls, assessor verdicts, and scope violations.

  Flags:
    --json      Emit structured JSON instead of formatted text.
    --verbose   Include per-attempt agent-call breakdowns and the full
                WI event log rather than the tail.
`);
    return;
  }

  const wiId = Number.parseInt(wiArg.replace(/^wi[:#-]?/i, ""), 10);
  if (!Number.isFinite(wiId) || wiId <= 0) {
    console.log(`\n  ${C.red}Invalid wi-id: ${wiArg}${C.reset}\n`);
    process.exitCode = 2;
    return;
  }

  const flags = new Set(args.slice(1).map((value) => String(value).toLowerCase()));
  const asJson = flags.has("--json");
  const verbose = flags.has("--verbose") || flags.has("-v");

  const data = buildTimeline(wiId);
  if (!data) {
    console.log(`\n  ${C.yellow}No work item found with id ${wiId}${C.reset}\n`);
    return;
  }
  if (asJson) {
    process.stdout.write(renderTimelineJson(data));
    return;
  }
  process.stdout.write(renderTimelineText(data, { verbose }));
}

function parseWorkItemArg(args) {
  const value = args.find((arg) => !String(arg).startsWith("--")) || null;
  if (!value) return null;
  const id = Number.parseInt(String(value).replace(/^wi[:#-]?/i, ""), 10);
  return Number.isFinite(id) && id > 0 ? id : NaN;
}

function printSessionSavings(rows, { title = "Session Recycling Savings" } = {}) {
  const totals = rows.reduce((acc, row) => {
    acc.samples += Number(row.samples) || 0;
    acc.resume += Number(row.tokens_resume) || 0;
    acc.fresh += Number(row.tokens_fresh_estimate) || 0;
    acc.saved += Number(row.tokens_saved) || 0;
    acc.negative += Number(row.negative_samples) || 0;
    return acc;
  }, { samples: 0, resume: 0, fresh: 0, saved: 0, negative: 0 });
  console.log(`\n  ${C.bold}${title}${C.reset}`);
  console.log(`  ${C.dim}Samples:${C.reset} ${totals.samples}  ${C.dim}Saved:${C.reset} ${formatSignedTokens(totals.saved)}  ${C.dim}Resume/Fresh:${C.reset} ${formatCostTokens(totals.resume)}/${formatCostTokens(totals.fresh)} tokens${totals.negative ? `  ${C.yellow}${totals.negative} negative${C.reset}` : ""}`);
  if (rows.length === 0) {
    console.log(`  ${C.dim}(no session recycling savings recorded)${C.reset}`);
    return;
  }
  console.log(`\n  ${C.bold}By provider / role / skill${C.reset}`);
  for (const row of rows) {
    const label = `${row.provider || "?"}/${row.role || "?"}${row.skill_key ? `/${row.skill_key}` : ""}`;
    console.log(`  ${label.padEnd(32)} ${formatSignedTokens(row.tokens_saved).padStart(8)}  ${C.dim}${row.samples} samples  resume/fresh ${formatCostTokens(row.tokens_resume)}/${formatCostTokens(row.tokens_fresh_estimate)}${C.reset}`);
  }
}

export function runSessionsCommand(args = []) {
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
  Usage: posse sessions [wi-id] [--json] [--savings] [--all]

  Lists session-recycling lanes and active handles. Use --savings for the
  isolated token-savings telemetry.
`);
    return;
  }
  const flags = new Set(args.filter((arg) => String(arg).startsWith("--")).map((arg) => String(arg).toLowerCase()));
  const wiId = parseWorkItemArg(args);
  if (Number.isNaN(wiId)) {
    console.log(`\n  ${C.red}Invalid wi-id${C.reset}\n`);
    process.exitCode = 2;
    return;
  }
  const asJson = flags.has("--json");
  const savingsOnly = flags.has("--savings");
  if (savingsOnly) {
    const rows = aggregateSessionRecycleSavings({ workItemId: wiId });
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ workItemId: wiId, savings: rows }, null, 2)}\n`);
      return;
    }
    printSessionSavings(rows, { title: wiId ? `Session Recycling Savings for WI#${wiId}` : "Session Recycling Savings" });
    console.log();
    return;
  }

  const lanes = listSessionLanes({ workItemId: wiId, status: flags.has("--all") ? null : "active" });
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ workItemId: wiId, lanes }, null, 2)}\n`);
    return;
  }
  console.log(`\n  ${C.bold}Session Recycling Lanes${C.reset}${wiId ? `  ${C.dim}WI#${wiId}${C.reset}` : ""}\n`);
  if (lanes.length === 0) {
    console.log(`  ${C.dim}(none)${C.reset}\n`);
    return;
  }
  for (const row of lanes) {
    const skill = row.skill_key ? ` skill:${row.skill_key}` : "";
    const session = row.active_session_id
      ? `hop ${row.active_hop_count || 0}${row.active_leased_by ? ` leased by #${row.active_leased_by}` : ""}`
      : "no active handle";
    console.log(`  WI#${String(row.work_item_id).padEnd(4)} ${String(row.lane).padEnd(9)} ${String(row.provider).padEnd(7)} ${row.status.padEnd(11)} ${session}${skill}`);
  }
  console.log();
}

const COST_VALUE_FLAGS = new Set(["--by", "--since"]);

function parseCostFlags(tokens) {
  const flags = {
    json: false,
    groupBy: null,
    since: null,
    pricing: false,
    recycling: false,
    setPricing: null,
  };
  for (let i = 0; i < tokens.length; i++) {
    // Lowercase only for flag-name matching; --since values are compared
    // verbatim against stored ...T...Z timestamps, so their casing must survive.
    const raw = String(tokens[i] || "");
    const arg = raw.toLowerCase();
    if (arg === "--json") flags.json = true;
    else if (arg === "--pricing") flags.pricing = true;
    else if (arg === "--recycling") flags.recycling = true;
    else if (arg === "--by" && tokens[i + 1]) { flags.groupBy = String(tokens[++i]).toLowerCase(); }
    else if (arg.startsWith("--by=")) { flags.groupBy = raw.slice(5).toLowerCase(); }
    else if (arg === "--since" && tokens[i + 1]) { flags.since = String(tokens[++i]); }
    else if (arg.startsWith("--since=")) { flags.since = raw.slice(8); }
  }
  return flags;
}

// First positional token, skipping flags and the values of value-taking flags
// so `cost --by role` does not read "role" as a wi-id.
function findCostWiArgIndex(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i] || "");
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && COST_VALUE_FLAGS.has(arg.toLowerCase())) i++;
      continue;
    }
    if (arg === "pricing") continue;
    return i;
  }
  return -1;
}

export function runCostCommand(args = []) {
  if (args[0] === "pricing") {
    const sub = args[1] || "list";
    if (sub === "set") {
      const [, , provider, model, inRate, outRate, tier, cachedRate] = args;
      if (!provider || !model || !inRate || !outRate) {
        console.log(`\n  Usage: posse cost pricing set <provider> <model> <inputPerM> <outputPerM> [tier] [cachedInputPerM]\n`);
        process.exitCode = 2;
        return;
      }
      try {
        const row = setPricing({
          provider,
          modelName: model,
          inputPerM: Number(inRate),
          outputPerM: Number(outRate),
          modelTier: tier || null,
          cachedInputPerM: cachedRate != null && cachedRate !== "" ? Number(cachedRate) : null,
        });
        console.log(`\n  ${C.green}Updated pricing:${C.reset} ${row.provider}/${row.modelName} in=$${row.inputPerM}/M out=$${row.outputPerM}/M${row.cachedInputPerM != null ? ` cached=$${row.cachedInputPerM}/M` : ""}${row.modelTier ? ` tier=${row.modelTier}` : ""}\n`);
      } catch (err) {
        console.log(`\n  ${C.red}Error:${C.reset} ${err.message}\n`);
        process.exitCode = 1;
      }
      return;
    }

    const dbRows = listPricing();
    const defaults = listDefaultPricing();
    console.log(`\n  ${C.bold}Pricing Overrides (DB)${C.reset} ${C.dim}(${dbRows.length} row(s))${C.reset}\n`);
    if (dbRows.length === 0) console.log(`  ${C.dim}(none - using baked-in defaults)${C.reset}`);
    for (const row of dbRows) {
      console.log(`  ${row.provider}/${row.modelName}  in=$${row.inputPerM}/M  cached=$${row.cachedInputPerM}/M  out=$${row.outputPerM}/M${row.modelTier ? `  ${C.dim}tier=${row.modelTier}${C.reset}` : ""}`);
    }
    console.log(`\n  ${C.bold}Baked-in defaults${C.reset} ${C.dim}(fallback when DB + family match miss)${C.reset}\n`);
    for (const row of defaults) {
      console.log(`  ${C.dim}${row.provider}/${row.modelName}  in=$${row.inputPerM}/M  out=$${row.outputPerM}/M  tier=${row.modelTier}${C.reset}`);
    }
    console.log();
    return;
  }

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
  Usage: posse cost [wi-id] [--json] [--by provider|role|tier|model|wi] [--since DATE]
         posse cost [wi-id] --recycling [--json]
         posse cost pricing [list|set <provider> <model> <in/M> <out/M> [tier] [cached-in/M]]

  No arguments: top 20 most-expensive work items + grand total.
  With wi-id:   per-WI breakdown (grouped by provider by default).

  Flags:
    --by         Group aggregate by provider|role|tier|model|wi (default: provider).
    --since      ISO timestamp filter on agent_calls.created_at.
    --json       Emit JSON instead of formatted text.
    --pricing    Append current pricing rows to the output.
    --recycling  Show isolated session-recycling token savings.
`);
    return;
  }

  const wiArgIndex = findCostWiArgIndex(args);
  const wiArg = wiArgIndex >= 0 ? args[wiArgIndex] : null;
  const flagTokens = args.filter((_, idx) => idx !== wiArgIndex);
  const flags = parseCostFlags(flagTokens);
  const wiId = wiArg ? Number.parseInt(String(wiArg).replace(/^wi[:#-]?/i, ""), 10) : null;

  if (wiArg && (!Number.isFinite(wiId) || wiId <= 0)) {
    console.log(`\n  ${C.red}Invalid wi-id: ${wiArg}${C.reset}\n`);
    process.exitCode = 2;
    return;
  }

  if (flags.recycling) {
    const rows = aggregateSessionRecycleSavings({ workItemId: wiId });
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ workItemId: wiId, savings: rows }, null, 2)}\n`);
      return;
    }
    printSessionSavings(rows, { title: wiId ? `Session Recycling Savings for WI#${wiId}` : "Session Recycling Savings" });
    console.log();
    return;
  }

  if (wiId != null) {
    const wi = getWorkItem(wiId);
    if (!wi) {
      console.log(`\n  ${C.yellow}No work item found with id ${wiId}${C.reset}\n`);
      return;
    }
    const totals = workItemCost(wiId, { since: flags.since });
    const groupBy = flags.groupBy || "provider";
    const grouped = aggregateCost({ groupBy, wiId, since: flags.since });
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ workItem: { id: wi.id, title: wi.title, status: wi.status }, totals, grouped }, null, 2)}\n`);
      return;
    }
    console.log(`\n  ${C.bold}Cost for WI#${wi.id}${C.reset}  ${wi.title}`);
    console.log(`  ${C.dim}Status:${C.reset} ${wi.status}  ${C.dim}Calls:${C.reset} ${totals.callCount}  ${C.dim}Tokens:${C.reset} ${formatCostTokens(totals.inputTokens)} in / ${formatCostTokens(totals.outputTokens)} out  ${C.dim}Total:${C.reset} ${C.bold}${formatUsd(totals.totalCostUsd)}${C.reset}`);
    if (totals.unknownCostCalls > 0) {
      console.log(`  ${C.yellow}!${C.reset}  ${totals.unknownCostCalls} call(s) had unknown pricing - edit with ${C.cyan}posse cost pricing set${C.reset}`);
    }
    console.log(`\n  ${C.bold}By ${groupBy}${C.reset}`);
    for (const row of grouped.groups) {
      console.log(`  ${row.key.padEnd(20)}  ${formatUsd(row.costUsd).padStart(9)}  ${C.dim}${formatCostTokens(row.inputTokens)}/${formatCostTokens(row.outputTokens)} tok  ${row.callCount} calls${row.unknownCostCalls > 0 ? `  ${C.yellow}${row.unknownCostCalls} unknown${C.reset}` : ""}${C.reset}`);
    }
    console.log();
    return;
  }

  const summary = topWorkItemCosts({ since: flags.since, limit: 20 });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  console.log(`\n  ${C.bold}Top Work Items by Cost${C.reset}  ${C.dim}(grand total: ${formatUsd(summary.totalCostUsd)}${summary.truncated ? "; more below the cutoff" : ""})${C.reset}\n`);
  for (const row of summary.workItems) {
    const wi = getWorkItem(row.wiId);
    const title = wi ? wi.title.slice(0, 60) : "(missing)";
    console.log(`  WI#${String(row.wiId).padEnd(4)}  ${formatUsd(row.totalCostUsd).padStart(9)}  ${C.dim}${formatCostTokens(row.inputTokens)}/${formatCostTokens(row.outputTokens)} tok  ${row.callCount} calls${row.unknownCostCalls > 0 ? `  ${C.yellow}${row.unknownCostCalls} unknown${C.reset}` : ""}${C.reset}  ${title}`);
  }
  console.log();
}

function formatFanoutPct(value) {
  if (value == null) return "n/a";
  return `${Math.round(Number(value) * 100)}%`;
}

function formatFanoutRatio(value) {
  if (value == null) return "n/a";
  return `${Number(value).toFixed(2)}x`;
}

function parseFanoutFlags(args) {
  const flags = { json: false, limit: 20, minRuns: 5, maxReviewRate: 0.2, firstPlanMin: 5, since: null };
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i] || "");
    if (arg === "--json") flags.json = true;
    else if (arg === "--limit" && args[i + 1]) flags.limit = Number.parseInt(String(args[++i]), 10);
    else if (arg.startsWith("--limit=")) flags.limit = Number.parseInt(arg.slice(8), 10);
    else if (arg === "--min-runs" && args[i + 1]) flags.minRuns = Number.parseInt(String(args[++i]), 10);
    else if (arg.startsWith("--min-runs=")) flags.minRuns = Number.parseInt(arg.slice(11), 10);
    else if (arg === "--max-review-rate" && args[i + 1]) flags.maxReviewRate = Number.parseFloat(String(args[++i]));
    else if (arg.startsWith("--max-review-rate=")) flags.maxReviewRate = Number.parseFloat(arg.slice(18));
    else if (arg === "--first-plan-min" && args[i + 1]) flags.firstPlanMin = Number.parseInt(String(args[++i]), 10);
    else if (arg.startsWith("--first-plan-min=")) flags.firstPlanMin = Number.parseInt(arg.slice(17), 10);
    else if (arg === "--since" && args[i + 1]) flags.since = String(args[++i]);
    else if (arg.startsWith("--since=")) flags.since = arg.slice(8);
  }
  if (!Number.isFinite(flags.limit) || flags.limit <= 0) flags.limit = 20;
  if (!Number.isFinite(flags.minRuns) || flags.minRuns <= 0) flags.minRuns = 5;
  if (!Number.isFinite(flags.maxReviewRate) || flags.maxReviewRate < 0 || flags.maxReviewRate > 1) flags.maxReviewRate = 0.2;
  if (!Number.isFinite(flags.firstPlanMin) || flags.firstPlanMin <= 0) flags.firstPlanMin = 5;
  return flags;
}

export function runFanoutCommand(args = []) {
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
  Usage: posse fanout [--json] [--limit N] [--since 30d]
         posse fanout [--min-runs N] [--max-review-rate 0.2]

  Summarizes research fanout telemetry: skipped candidates, shadow/active runs,
  synthesis citation signals, needs_review/contradiction rates, cost comparison,
  and whether the data is strong enough to consider default-on fanout.
`);
    return;
  }

  const flags = parseFanoutFlags(args);
  const report = buildResearchFanoutReport({
    limit: flags.limit,
    minShadowRuns: flags.minRuns,
    maxNeedsReviewRate: flags.maxReviewRate,
    firstPassPlanSampleMin: flags.firstPlanMin,
    since: flags.since,
  });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const ready = report.readiness.defaultOnReady;
  console.log(`\n  ${C.bold}Research Fanout Report${C.reset}`);
  console.log(`  ${C.dim}${"---".repeat(17)}${C.reset}`);
  console.log(`  Mode: ${C.cyan}${report.currentMode}${C.reset}  ${C.dim}Generated: ${report.generatedAt}${C.reset}`);
  if (report.since) {
    console.log(`  ${C.dim}Since: ${report.since}${C.reset}`);
  }

  console.log(`\n  ${C.bold}Volume${C.reset}`);
  console.log(`    skipped candidates: ${report.totals.skippedCandidates}`);
  console.log(`    runs: ${report.totals.fanoutRuns} ${C.dim}(shadow ${report.totals.shadowRuns}, active ${report.totals.activeRuns})${C.reset}`);
  console.log(`    completed synthesis: ${report.totals.completedSynthRuns} ${C.dim}(shadow ${report.totals.completedShadowRuns})${C.reset}`);
  console.log(`    completed children: ${report.totals.childCompleted}`);

  console.log(`\n  ${C.bold}Quality Signals${C.reset}`);
  console.log(`    line-ref coverage: ${formatFanoutPct(report.rates.lineRefCoverageRate)} ${C.dim}(${report.totals.lineRefCount} refs total)${C.reset}`);
  console.log(`    URL citation coverage: ${formatFanoutPct(report.rates.urlCitationCoverageRate)} ${C.dim}(${report.totals.urlCitationCount} URL refs total)${C.reset}`);
  console.log(`    needs_review rate: ${formatFanoutPct(report.rates.needsReviewRate)} ${C.dim}(${report.totals.needsReviewRuns} run(s))${C.reset}`);
  console.log(`    contradiction signal rate: ${formatFanoutPct(report.rates.contradictionSignalRate)} ${C.dim}(${report.totals.contradictionSignalRuns} run(s))${C.reset}`);
  console.log(`    fanout web tools: ${report.totals.fanoutWebToolCalls || 0} ${C.dim}(fetch ${report.totals.fanoutWebFetchCalls || 0}, search ${report.totals.fanoutWebSearchCalls || 0}, duplicate fetches within runs ${report.totals.fanoutDuplicateFetchedUrlsWithinRuns || 0}, unique URLs across runs ${report.totals.fanoutUniqueFetchedUrlsAcrossRuns || report.totals.fanoutUniqueFetchedUrls || 0})${C.reset}`);
  const firstPassRate = report.rates.firstPassPlanRate == null
    ? `n/a (n=${report.rates.firstPassPlanSampleSize}, min=${report.rates.firstPassPlanSampleMin})`
    : formatFanoutPct(report.rates.firstPassPlanRate);
  console.log(`    first-pass plan rate: ${firstPassRate}`);

  console.log(`\n  ${C.bold}Cost vs Solo${C.reset}`);
  console.log(`    comparable shadow runs: ${report.cost.comparableShadowRuns}`);
  console.log(`    solo: ${formatUsd(report.cost.soloCostUsd)}  fanout: ${formatUsd(report.cost.fanoutCostUsd)} ${C.dim}(children ${formatUsd(report.cost.childCostUsd)}, synth ${formatUsd(report.cost.synthCostUsd)})${C.reset}  ratio: ${formatFanoutRatio(report.cost.ratioVsSolo)}`);
  if (report.currentMode === "on" && report.cost.comparableShadowRuns === 0) {
    console.log(`    ${C.dim}(active mode: cost comparison requires shadow runs with a solo baseline)${C.reset}`);
  }

  console.log(`\n  ${C.bold}Default-On Readiness${C.reset}`);
  if (ready) {
    console.log(`    ${C.green}ready by current thresholds${C.reset}`);
  } else {
    console.log(`    ${C.yellow}not ready yet${C.reset}`);
    for (const blocker of report.readiness.blockers) {
      console.log(`    - ${blocker}`);
    }
  }

  if (report.runs.length > 0) {
    console.log(`\n  ${C.bold}Recent Runs${C.reset}`);
    for (const run of report.runs) {
      const status = run.synthCompleted ? `${C.green}complete${C.reset}` : `${C.yellow}pending${C.reset}`;
      const costRatio = run.costRatioVsSolo == null ? "" : ` cost=${formatFanoutRatio(run.costRatioVsSolo)}`;
      const review = run.needsReview ? ` ${C.yellow}needs_review${C.reset}` : "";
      const web = run.fanoutWebTools?.total ? ` web=${run.fanoutWebTools.total}` : "";
      console.log(`    ${status} ${String(run.mode || "?").padEnd(6)} WI#${run.workItemId || "?"} refs=${run.lineRefCount} urls=${run.urlCitationCount}${web} contradictions=${run.contradictionSignalCount}${costRatio}${review} ${C.dim}${String(run.workItemTitle || "").slice(0, 58)}${C.reset}`);
    }
  }

  if (report.skipped.length > 0) {
    console.log(`\n  ${C.bold}Recent Skipped Candidates${C.reset}`);
    for (const item of report.skipped) {
      console.log(`    WI#${item.workItemId || "?"} branches=${item.branchCount} budget=${item.actualBudget || item.budget || "?"} ${C.dim}${String(item.workItemTitle || item.reason || "").slice(0, 70)}${C.reset}`);
    }
  }

  console.log();
}
