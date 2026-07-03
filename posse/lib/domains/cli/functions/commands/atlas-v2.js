// ATLAS v2 operator CLI surface.
//
// Subcommands:
//   status                — overview of ledger/view state and warmer queue.
//   rebuild               — drop a view and queue a `atlas_warm` to rebuild it.
//   ledger tail           — print the most recent ledger entries on a branch.
//   view info             — describe one view file (path, freshness, sizes).
//   warm-now              — synchronously enqueue a warm job, no waiting.
//   models pull           — download the local ONNX model cache.
//   purge-views           — delete view files (warmed/, main view, WI views).
//   scip ...              — inspect/install/restage/ingest SCIP artifacts.
//
// All subcommands are read-only by default. `rebuild`, `warm-now`, and
// `purge-views` mutate the ATLAS on-disk layout but never the host repo.
//
// Workstream F owns this file. The warmer that consumes `atlas_warm` jobs
// is implemented in Phase 2; until then `warm-now` and `rebuild` produce
// queued jobs that the deterministic AtlasWarmRole drains (currently as a
// no-op stub — observable via `posse atlas-v2 status`).

import fs from "fs";
import path from "path";
import { getDb } from "../../../../shared/storage/functions/index.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { ATLAS_WARM_JOB_TYPE, ATLAS_WARM_JOB_POLICY } from "../../../atlas/functions/v2/contracts/jobs.js";
import { ATLAS_EVENT_NAMES } from "../../../atlas/functions/v2/contracts/events.js";
import {
  loadAtlasV2ProcessIndicators,
  renderAtlasV2ProcessIndicators,
} from "../../../atlas/functions/v2/process-indicators.js";
import { Ledger } from "../../../atlas/classes/v2/Ledger.js";
import { ingestScipFile, listScipFiles } from "../../../atlas/functions/v2/scip/ingester.js";
import { describeScipStagingState, ensureScipStaged } from "../../../atlas/functions/v2/scip/stager.js";
import {
  getScipLanguageDependencyStatus,
  installScipLanguageDependenciesSync,
} from "../../../atlas/functions/v2/scip/dependencies.js";
import { ATLAS_SCIP_LANGUAGE_VALUES, normalizeScipLanguages } from "../../../atlas/functions/v2/scip/languages.js";
import { getAtlasIntegrationConfig } from "../../../integrations/functions/atlas/config.js";
import { normalizeAtlasScipMode } from "../../../integrations/functions/atlas-v2-mode.js";
import {
  DEFAULT_LOCAL_ONNX_MODEL_ID,
  LOCAL_ONNX_MODELS,
  localOnnxModelCacheDir,
  modelCachePresent,
  resolveLocalOnnxCacheDir,
} from "../../../atlas/functions/v2/embeddings/local-onnx.js";
import { ensureOnnxModelCached } from "../../../atlas/functions/v2/embeddings/onnx-bootstrap.js";
import { ATLAS_V2_HELP_COMMANDS } from "../atlas-v2-help.js";
import { gitExecSafe } from "../../../git/functions/utils.js";

function nowIso() {
  return new Date().toISOString();
}

function formatAtlasError(err) {
  return err instanceof Error ? err.message : String(err);
}

function fileExistsSafe(filePath) {
  try { return fs.existsSync(filePath); } catch { return false; }
}

function statSafe(filePath) {
  try { return fs.statSync(filePath); } catch { return null; }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "(unknown)";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "(unknown)";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function repoAtlasPaths(projectDir) {
  const atlasRoot = path.join(projectDir, ".posse", "atlas");
  return {
    atlasRoot,
    ledgerDb: path.join(atlasRoot, "ledger.db"),
    viewsRoot: path.join(atlasRoot, "views"),
    mainView: path.join(atlasRoot, "views", "main.view.db"),
    warmedRoot: path.join(atlasRoot, "views", "warmed"),
  };
}

function listWarmedViews(warmedRoot) {
  if (!fileExistsSafe(warmedRoot)) return [];
  try {
    return fs
      .readdirSync(warmedRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".view.db"))
      .map((entry) => path.join(warmedRoot, entry.name));
  } catch {
    return [];
  }
}

function warmerQueueStats() {
  try {
    const db = getDb();
    const counts = db.prepare(`
      SELECT status, COUNT(*) AS cnt
      FROM jobs
      WHERE job_type = ?
      GROUP BY status
    `).all(ATLAS_WARM_JOB_TYPE);
    const summary = Object.create(null);
    for (const row of counts) summary[row.status] = row.cnt;
    const totals = {
      queued: summary.queued || 0,
      running: summary.running || 0,
      leased: summary.leased || 0,
      succeeded: summary.succeeded || 0,
      failed: summary.failed || 0,
      dead_letter: summary.dead_letter || 0,
      canceled: summary.canceled || 0,
    };
    return { ok: true, counts: totals, raw: summary };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), counts: null };
  }
}

function recentAtlasEvents({ limit = 10 } = {}) {
  try {
    const db = getDb();
    const placeholders = ATLAS_EVENT_NAMES.map(() => "?").join(",");
    return db.prepare(`
      SELECT id, event_type, work_item_id, job_id, created_at
      FROM events
      WHERE event_type IN (${placeholders})
      ORDER BY id DESC
      LIMIT ?
    `).all(...ATLAS_EVENT_NAMES, Number(limit) || 10);
  } catch {
    return [];
  }
}

function viewInfo(viewPath) {
  const stat = statSafe(viewPath);
  return {
    path: viewPath,
    exists: !!stat,
    size: stat?.size ?? 0,
    mtime: stat?.mtime ? new Date(stat.mtime).toISOString() : null,
    age_ms: stat?.mtime ? Date.now() - new Date(stat.mtime).getTime() : null,
  };
}

function ledgerInfo(ledgerDbPath) {
  const stat = statSafe(ledgerDbPath);
  return {
    path: ledgerDbPath,
    exists: !!stat,
    size: stat?.size ?? 0,
    mtime: stat?.mtime ? new Date(stat.mtime).toISOString() : null,
  };
}

function printStatus({ projectDir }) {
  const paths = repoAtlasPaths(projectDir);
  const ledger = ledgerInfo(paths.ledgerDb);
  const mainView = viewInfo(paths.mainView);
  const warmedFiles = listWarmedViews(paths.warmedRoot);
  const warmer = warmerQueueStats();
  const recent = recentAtlasEvents({ limit: 5 });

  console.log(`\n  ${C.bold}ATLAS v2 Status${C.reset} ${C.dim}(${paths.atlasRoot})${C.reset}`);
  console.log(`  ${C.bold}Ledger:${C.reset} ${ledger.exists ? `${C.green}present${C.reset}` : `${C.yellow}absent${C.reset}`} ` +
    `${C.dim}${formatBytes(ledger.size)}${ledger.mtime ? `, updated ${ledger.mtime}` : ""}${C.reset}`);
  console.log(`  ${C.bold}Main view:${C.reset} ${mainView.exists ? `${C.green}present${C.reset}` : `${C.yellow}absent${C.reset}`} ` +
    `${C.dim}${formatBytes(mainView.size)}${mainView.age_ms != null ? `, age ${formatDuration(mainView.age_ms)}` : ""}${C.reset}`);
  console.log(`  ${C.bold}Warmed views:${C.reset} ${warmedFiles.length}`);
  for (const file of warmedFiles.slice(0, 10)) {
    const info = viewInfo(file);
    console.log(`    - ${path.basename(file)} ${C.dim}${formatBytes(info.size)}, age ${formatDuration(info.age_ms || 0)}${C.reset}`);
  }
  if (warmedFiles.length > 10) {
    console.log(`    ${C.dim}... and ${warmedFiles.length - 10} more${C.reset}`);
  }

  console.log(`\n  ${C.bold}Indexing / Edge Indicators:${C.reset}`);
  const indicators = loadAtlasV2ProcessIndicators({ projectDir, limit: 6 });
  for (const line of renderAtlasV2ProcessIndicators(indicators, { colors: C, width: 110 })) {
    console.log(`  ${line.trimStart()}`);
  }

  console.log(`\n  ${C.bold}Warmer queue (${ATLAS_WARM_JOB_TYPE}):${C.reset}`);
  if (!warmer.ok) {
    console.log(`    ${C.red}error: ${warmer.error}${C.reset}`);
  } else {
    const c = warmer.counts;
    console.log(`    queued=${c.queued}  leased=${c.leased}  running=${c.running}  succeeded=${c.succeeded}  failed=${c.failed}  dead=${c.dead_letter}`);
  }

  console.log(`\n  ${C.bold}Recent ATLAS events:${C.reset}`);
  if (recent.length === 0) {
    console.log(`    ${C.dim}(none)${C.reset}`);
  } else {
    for (const row of recent) {
      console.log(`    #${row.id} ${row.event_type} ${C.dim}wi=${row.work_item_id ?? "-"} job=${row.job_id ?? "-"} at ${row.created_at}${C.reset}`);
    }
  }
  console.log("");
  return { ledger, mainView, warmedCount: warmedFiles.length, warmer, recent, indicators };
}

function enqueueWarmJob({ purpose, branch, paths, workItemId = null, outViewPath = null, triggerEvent = "cli.atlas-v2" }) {
  const db = getDb();
  const payload = {
    purpose,
    branch: branch || (purpose === "wi" ? null : "main"),
    paths: Array.isArray(paths) ? paths.filter(Boolean) : [],
    trigger_event: triggerEvent,
  };
  if (purpose === "wi" && workItemId != null) payload.work_item_id = Number(workItemId);
  if (outViewPath) payload.out_view_path = outViewPath;

  const title = `ATLAS warm: ${purpose}${workItemId != null ? ` wi#${workItemId}` : ""}`;
  const info = db.prepare(`
    INSERT INTO jobs (
      work_item_id, job_type, title,
      priority, model_tier, reasoning_effort, provider,
      max_attempts, payload_json, ready_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)
  `).run(
    purpose === "wi" && workItemId != null ? Number(workItemId) : null,
    ATLAS_WARM_JOB_TYPE,
    title,
    ATLAS_WARM_JOB_POLICY.defaultPriority,
    ATLAS_WARM_JOB_POLICY.maxAttempts,
    JSON.stringify(payload),
    nowIso(),
  );
  return Number(info.lastInsertRowid);
}

function printWarmNow({ projectDir, args }) {
  const purpose = String(args[0] || "main-incremental");
  if (!["wi", "main-incremental", "main-full", "scip-restage"].includes(purpose)) {
    console.log(`  ${C.red}Unknown warm purpose: ${purpose}${C.reset}`);
    console.log(`  Usage: posse atlas-v2 warm-now <wi|main-incremental|main-full|scip-restage> [wi-id] [path,path,...]`);
    return null;
  }

  const restArgs = args.slice(1);
  let workItemId = null;
  let pathsArg = null;
  if (purpose === "wi") {
    workItemId = Number(restArgs[0]);
    if (!Number.isFinite(workItemId)) {
      console.log(`  ${C.red}atlas-v2 warm-now wi requires a numeric work-item id${C.reset}`);
      return null;
    }
    pathsArg = restArgs[1];
  } else {
    pathsArg = restArgs[0];
  }
  const paths = pathsArg ? String(pathsArg).split(",").map((value) => value.trim()).filter(Boolean) : [];

  const branch = purpose === "wi" ? null : "main";
  const outViewPath = purpose === "wi"
    ? path.join(repoAtlasPaths(projectDir).warmedRoot, `wi-${workItemId}.view.db`)
    : repoAtlasPaths(projectDir).mainView;

  try {
    const jobId = enqueueWarmJob({ purpose, branch, paths, workItemId, outViewPath });
    console.log(`  ${C.green}[atlas-v2]${C.reset} enqueued ${ATLAS_WARM_JOB_TYPE} job #${jobId} (purpose=${purpose}${workItemId != null ? `, wi=${workItemId}` : ""}, paths=${paths.length})`);
    return { ok: true, jobId, purpose, paths, workItemId };
  } catch (err) {
    console.log(`  ${C.red}atlas-v2 warm-now failed: ${err?.message || String(err)}${C.reset}`);
    return { ok: false, error: err?.message || String(err) };
  }
}

function printRebuild({ projectDir, args }) {
  const target = String(args[0] || "main").toLowerCase();
  const paths = repoAtlasPaths(projectDir);
  let viewPath;
  let purpose;
  let workItemId = null;
  if (target === "main") {
    viewPath = paths.mainView;
    purpose = "main-full";
  } else if (/^wi-?(\d+)$/.test(target)) {
    workItemId = Number(target.replace(/[^0-9]/g, ""));
    viewPath = path.join(paths.warmedRoot, `wi-${workItemId}.view.db`);
    purpose = "wi";
  } else {
    console.log(`  ${C.red}atlas-v2 rebuild target must be 'main' or 'wi-<id>'${C.reset}`);
    return null;
  }

  let removed = false;
  if (fileExistsSafe(viewPath)) {
    try {
      fs.rmSync(viewPath, { force: true });
      removed = true;
    } catch (err) {
      console.log(`  ${C.red}atlas-v2 rebuild: failed to delete ${viewPath}: ${err?.message || err}${C.reset}`);
      return null;
    }
  }
  let jobId = null;
  const branch = purpose === "wi" ? null : "main";
  try {
    jobId = enqueueWarmJob({ purpose, branch, workItemId, outViewPath: viewPath });
  } catch (err) {
    console.log(`  ${C.red}atlas-v2 rebuild: failed to enqueue warm: ${err?.message || err}${C.reset}`);
    return null;
  }
  console.log(`  ${C.green}[atlas-v2]${C.reset} rebuild ${target}: removed=${removed} warm-job=#${jobId} -> ${path.relative(projectDir, viewPath)}`);
  return { target, removed, jobId };
}

async function printLedgerTail({ projectDir, args }) {
  const branch = String(args[0] || "main");
  const limit = Math.max(1, Math.min(500, Number(args[1]) || 25));
  const paths = repoAtlasPaths(projectDir);
  if (!fileExistsSafe(paths.ledgerDb)) {
    console.log(`  ${C.yellow}atlas-v2 ledger tail: no ledger at ${paths.ledgerDb}${C.reset}`);
    return null;
  }

  let LedgerCtor = null;
  try {
    const ledgerModule = await import("../../../atlas/classes/v2/Ledger.js");
    LedgerCtor = ledgerModule.Ledger;
  } catch (err) {
    console.log(`  ${C.yellow}atlas-v2 ledger tail: backend not available (${err?.message || err})${C.reset}`);
    return null;
  }

  try {
    const ledger = new LedgerCtor({ dbPath: paths.ledgerDb });
    const head = ledger.headSeq(branch);
    const fromSeq = Math.max(0, head - limit);
    const entries = ledger.tail(branch, fromSeq, limit);
    console.log(`\n  ${C.bold}Ledger tail${C.reset} branch=${branch} head=${head} showing ${entries.length}/${limit}`);
    for (const entry of entries) {
      console.log(`    seq=${entry.seq} ${entry.op.padEnd(6)} ${entry.repo_rel_path} ${C.dim}${entry.ts}${C.reset}`);
    }
    ledger.close();
    return { branch, head, entries };
  } catch (err) {
    console.log(`  ${C.red}atlas-v2 ledger tail failed: ${err?.message || err}${C.reset}`);
    return null;
  }
}

function printViewInfo({ projectDir, args }) {
  const target = String(args[0] || "main").toLowerCase();
  const paths = repoAtlasPaths(projectDir);
  let viewPath;
  if (target === "main") viewPath = paths.mainView;
  else if (/^wi-?(\d+)$/.test(target)) viewPath = path.join(paths.warmedRoot, `wi-${target.replace(/[^0-9]/g, "")}.view.db`);
  else viewPath = path.resolve(projectDir, args[0]);

  const info = viewInfo(viewPath);
  console.log(`\n  ${C.bold}View info${C.reset} ${viewPath}`);
  console.log(`    exists: ${info.exists ? `${C.green}yes${C.reset}` : `${C.yellow}no${C.reset}`}`);
  console.log(`    size:   ${formatBytes(info.size)}`);
  console.log(`    mtime:  ${info.mtime || "(none)"}`);
  console.log(`    age:    ${info.age_ms != null ? formatDuration(info.age_ms) : "(unknown)"}`);
  console.log("");
  return info;
}

function printPurgeViews({ projectDir, args }) {
  const scope = String(args[0] || "warmed").toLowerCase();
  const paths = repoAtlasPaths(projectDir);
  const removed = [];
  function tryRemove(filePath) {
    if (!fileExistsSafe(filePath)) return;
    try {
      fs.rmSync(filePath, { force: true });
      removed.push(filePath);
    } catch { /* best effort */ }
  }
  if (scope === "warmed" || scope === "all") {
    for (const file of listWarmedViews(paths.warmedRoot)) tryRemove(file);
  }
  if (scope === "main" || scope === "all") {
    tryRemove(paths.mainView);
  }
  console.log(`  ${C.green}[atlas-v2]${C.reset} purged ${removed.length} view file(s) (scope=${scope})`);
  for (const file of removed.slice(0, 20)) console.log(`    - ${path.relative(projectDir, file)}`);
  if (removed.length > 20) console.log(`    ${C.dim}... and ${removed.length - 20} more${C.reset}`);
  return { removed };
}

async function runModelsPull({ projectDir, args }) {
  const modelId = String(args[0] || DEFAULT_LOCAL_ONNX_MODEL_ID).trim();
  const model = LOCAL_ONNX_MODELS[modelId];
  if (!model) {
    console.log(`  ${C.red}[atlas-v2 models]${C.reset} unknown model '${modelId}'. Use ${DEFAULT_LOCAL_ONNX_MODEL_ID}.`);
    return { ok: false, error: "unknown_model", modelId };
  }
  const cacheDir = resolveLocalOnnxCacheDir({ repoRoot: projectDir, config: getAtlasIntegrationConfig() });
  if (!cacheDir) {
    console.log(`  ${C.red}[atlas-v2 models]${C.reset} could not resolve local ONNX cache directory`);
    return { ok: false, error: "cache_dir_unresolved", modelId };
  }
  const targetDir = localOnnxModelCacheDir(cacheDir, model);
  console.log(`  ${C.cyan}[atlas-v2 models]${C.reset} pulling ${modelId} to ${path.relative(projectDir, targetDir) || targetDir}`);
  let wroteProgress = false;
  try {
    await ensureOnnxModelCached({
      modelName: model.model,
      modelId: model.id,
      cacheDir,
      dtype: model.dtype || "q8",
      onProgress: (p) => {
        if (p?.status === "progress" && p?.file) {
          const pct = p.loaded && p.total ? Math.round((p.loaded / p.total) * 100) : 0;
          wroteProgress = true;
          process.stdout.write(`\r  ${C.dim}${p.file} ${pct}%${C.reset}`);
        }
      },
    });
    if (wroteProgress) process.stdout.write("\n");
    const present = modelCachePresent(cacheDir, model);
    console.log(`  ${present ? C.green : C.yellow}[atlas-v2 models]${C.reset} ${present ? "ready" : "download finished but model file was not detected"}: ${targetDir}`);
    return { ok: present, modelId, cacheDir, modelCacheDir: targetDir };
  } catch (err) {
    if (wroteProgress) process.stdout.write("\n");
    console.log(`  ${C.red}[atlas-v2 models]${C.reset} pull failed: ${formatAtlasError(err)}`);
    return { ok: false, error: formatAtlasError(err), modelId, cacheDir, modelCacheDir: targetDir };
  }
}

function scipDir(projectDir) {
  return path.join(projectDir, ".posse", "atlas", "scip");
}

function openLedgerForCli(projectDir) {
  const paths = repoAtlasPaths(projectDir);
  if (!fileExistsSafe(paths.ledgerDb)) {
    console.log(`  ${C.yellow}[atlas-v2 scip]${C.reset} no ledger at ${path.relative(projectDir, paths.ledgerDb)} — nothing to do`);
    return null;
  }
  return Ledger.open({ dbPath: paths.ledgerDb });
}

/**
 * @param {string[]} args
 * @param {{ allowLang?: boolean }} [opts]
 * @returns {{ branch: string | null, branchExplicit: boolean, langFilter: string | null, targets: string[] }}
 */
function parseScipArgs(args, opts = {}) {
  let branch = null;
  let branchExplicit = false;
  let langFilter = null;
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--branch") {
      branchExplicit = true;
      branch = String(args[++i] || "").trim() || null;
      continue;
    }
    if (opts.allowLang && a === "--lang") {
      langFilter = String(args[++i] || "").toLowerCase();
      continue;
    }
    targets.push(a);
  }
  return { branch, branchExplicit, langFilter, targets };
}

/**
 * @param {string} projectDir
 * @param {Ledger} led
 * @param {string | null} requested
 * @param {{ explicit?: boolean, onWarning?: (message: string) => void }} [opts]
 * @returns {string}
 */
function resolveScipBranch(projectDir, led, requested, opts = {}) {
  const explicit = !!opts.explicit && !!requested;
  if (explicit) {
    const branch = String(requested || "").trim();
    if (!led.getBranch(branch)) {
      throw new Error(`SCIP target branch '${branch}' does not exist; create it first or omit --branch to auto-detect`);
    }
    return branch;
  }
  const detected = detectGitDefaultBranch(projectDir) || detectGitCurrentBranch(projectDir);
  const branch = String(detected || "main").trim() || "main";
  if (!detected && typeof opts.onWarning === "function") {
    opts.onWarning("could not detect a git branch; defaulting SCIP ingest to ledger branch 'main'");
  }
  if (!led.getBranch(branch) && typeof led.ensureRootBranch === "function") {
    led.ensureRootBranch(branch);
  }
  return branch;
}

/**
 * @param {string} projectDir
 * @returns {string}
 */
function detectGitDefaultBranch(projectDir) {
  const out = gitOutput(projectDir, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (!out || out === "origin/HEAD") return "";
  return out.includes("/") ? out.slice(out.indexOf("/") + 1) : out;
}

/**
 * @param {string} projectDir
 * @returns {string}
 */
function detectGitCurrentBranch(projectDir) {
  return gitOutput(projectDir, ["branch", "--show-current"]);
}

/**
 * @param {string} projectDir
 * @param {string[]} args
 * @returns {string}
 */
function gitOutput(projectDir, args) {
  return gitExecSafe(args, projectDir);
}

async function printScipStatus({ projectDir }) {
  const config = getAtlasIntegrationConfig();
  const mode = normalizeAtlasScipMode(config.scipMode);
  const languages = normalizeScipLanguages(config.scipLanguages);
  console.log(`\n  ${C.bold}SCIP status${C.reset}`);
  console.log(`    Mode (atlas_scip_mode): ${C.cyan}${mode}${C.reset}`);
  console.log(`    Languages enabled (atlas_scip_languages): ${C.cyan}${languages.join(",")}${C.reset}`);
  console.log(`    Restage policy (atlas_scip_restage_policy): ${C.cyan}${config.scipRestagePolicy || "missing"}${C.reset}`);
  console.log(`    Cold timeout: ${C.cyan}${config.scipColdIndexTimeoutMs ?? 600000}ms${C.reset}`);
  console.log(`    Smart max age: ${C.cyan}${config.scipMaxAgeHours ?? 24}h${C.reset}`);

  const dir = scipDir(projectDir);
  const dirExists = fileExistsSafe(dir);
  console.log(`    Consume directory: ${dirExists ? C.cyan : C.dim}${path.relative(projectDir, dir)}${C.reset} ${dirExists ? "" : C.dim + "(missing)" + C.reset}`);
  const depStatus = getScipLanguageDependencyStatus({ languages });
  if (depStatus.length > 0) {
    console.log(`    Indexer deps:`);
    for (const dep of depStatus) {
      const color = dep.ok ? C.green : C.yellow;
      console.log(`      - ${dep.language}: ${color}${dep.status}${C.reset} ${C.dim}${dep.message}${C.reset}`);
    }
  }

  if (dirExists) {
    /** @type {string[]} */
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".scip")).sort();
    } catch { /* unreadable — leave files empty */ }
    if (files.length === 0) {
      console.log(`    ${C.dim}no .scip files found${C.reset}`);
    } else {
      console.log(`    .scip files (${files.length}):`);
      for (const f of files) {
        const st = statSafe(path.join(dir, f));
        const size = st ? formatBytes(st.size) : "?";
        console.log(`      - ${f}  ${C.dim}${size}${C.reset}`);
      }
    }
  }
  try {
    const staging = await describeScipStagingState({ repoRoot: projectDir, scipDir: dir, config });
    if (staging.rows.length > 0) {
      const current = staging.currentHead ? staging.currentHead.slice(0, 8) : "unknown";
      console.log(`\n    Staging freshness (HEAD ${current}):`);
      for (const row of staging.rows) {
        const status = row.meta_status === "failed" ? "failed" : (!row.exists ? "missing" : (row.fresh ? "fresh" : (row.reason === "head_unresolved" ? "unknown" : "stale")));
        const color = status === "fresh" ? C.green : (status === "missing" || status === "failed" ? C.yellow : C.cyan);
        const metaHead = row.meta?.head ? String(row.meta.head).slice(0, 8) : "-";
        const stagedAt = row.meta?.staged_at || row.meta?.failed_at ? String(row.meta.staged_at || row.meta.failed_at) : "-";
        console.log(`      ${row.language.padEnd(12)} ${color}${status}${C.reset}  head=${metaHead}  staged=${C.dim}${stagedAt}${C.reset}  reason=${row.reason}`);
      }
    }
  } catch (err) {
    console.log(`    ${C.yellow}staging freshness unavailable: ${formatAtlasError(err)}${C.reset}`);
  }

  const led = openLedgerForCli(projectDir);
  if (!led) return null;
  try {
    const rows = led.listScipIndexes();
    if (rows.length === 0) {
      console.log(`\n    ${C.dim}no ingested SCIP indexes recorded yet${C.reset}\n`);
      return { rows: [] };
    }
    console.log(`\n    Ingested SCIP indexes (${rows.length}):`);
    for (const r of rows.slice(0, 20)) {
      const failed = r.documents_failed ? ` failed=${r.documents_failed}` : "";
      const status = r.status === "partial" ? ` ${C.yellow}partial${C.reset}` : "";
      console.log(`      ${C.cyan}${r.scheme}${C.reset} ${r.indexer_version}${status}  docs=${r.document_count}${failed} occs=${r.occurrence_count} ext=${r.external_symbol_count}  ${C.dim}${r.ingested_at}${C.reset}`);
    }
    if (rows.length > 20) {
      console.log(`      ${C.dim}... and ${rows.length - 20} more${C.reset}`);
    }
    console.log("");
    return { rows };
  } finally {
    led.close();
  }
}

function parseScipInstallArgs(args = []) {
  const languages = [];
  let force = false;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i] || "");
    if (arg === "--force") {
      force = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--all") {
      languages.push(...ATLAS_SCIP_LANGUAGE_VALUES);
    } else if (arg === "--lang" || arg === "--language") {
      if (args[i + 1]) languages.push(args[++i]);
    } else if (arg.startsWith("--lang=")) {
      languages.push(arg.slice("--lang=".length));
    } else if (arg.startsWith("--language=")) {
      languages.push(arg.slice("--language=".length));
    } else if (arg && !arg.startsWith("-")) {
      languages.push(arg);
    }
  }
  return { languages, force, dryRun };
}

function runScipInstall({ args }) {
  const parsed = parseScipInstallArgs(args);
  const config = getAtlasIntegrationConfig();
  const languages = parsed.languages.length > 0
    ? normalizeScipLanguages(parsed.languages, { defaultLanguages: [] })
    : normalizeScipLanguages(config.scipLanguages);
  if (languages.length === 0) {
    console.log(`  ${C.red}[atlas-v2 scip install]${C.reset} no valid languages selected. Valid: ${ATLAS_SCIP_LANGUAGE_VALUES.join(", ")}`);
    return { ok: false, languages: [], results: [] };
  }
  console.log(`  ${C.cyan}[atlas-v2 scip install]${C.reset} languages: ${languages.join(", ")}${parsed.dryRun ? " (dry run)" : ""}`);
  const result = installScipLanguageDependenciesSync({
    languages,
    force: parsed.force,
    dryRun: parsed.dryRun,
    onProgress: (message) => console.log(`  ${C.dim}[atlas-v2 scip install]${C.reset} ${message}`),
  });
  for (const row of result.results) {
    const color = row.ok ? C.green : C.yellow;
    console.log(`  ${color}[atlas-v2 scip install]${C.reset} ${row.language}: ${row.status} - ${row.message}`);
  }
  return result;
}

function parseScipRestageArgs(args = []) {
  let lang = null;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i] || "");
    if (arg === "--force") {
      force = true;
    } else if (arg === "--lang" || arg === "--language") {
      lang = String(args[++i] || "").trim() || null;
    } else if (arg.startsWith("--lang=")) {
      lang = arg.slice("--lang=".length);
    } else if (arg.startsWith("--language=")) {
      lang = arg.slice("--language=".length);
    } else if (arg && !arg.startsWith("-")) {
      lang = arg;
    }
  }
  return { lang, force };
}

async function runScipRestage({ projectDir, args }) {
  const parsed = parseScipRestageArgs(args);
  const config = getAtlasIntegrationConfig();
  const selectedLanguages = parsed.lang
    ? normalizeScipLanguages(parsed.lang, { defaultLanguages: [] })
    : normalizeScipLanguages(config.scipLanguages);
  if (parsed.lang && selectedLanguages.length === 0) {
    console.log(`  ${C.red}[atlas-v2 scip restage]${C.reset} unknown language '${parsed.lang}'. Valid: ${ATLAS_SCIP_LANGUAGE_VALUES.join(", ")}`);
    return { ok: false, error: "invalid_language" };
  }
  const restageConfig = {
    ...config,
    scipLanguages: selectedLanguages,
    scipRestagePolicy: parsed.force ? "always" : (config.scipRestagePolicy || "missing"),
  };
  console.log(`  ${C.cyan}[atlas-v2 scip restage]${C.reset} languages: ${selectedLanguages.join(", ")} policy=${restageConfig.scipRestagePolicy}`);
  const result = await ensureScipStaged({
    repoRoot: projectDir,
    scipDir: scipDir(projectDir),
    mode: normalizeAtlasScipMode(config.scipMode),
    config: restageConfig,
    onProgress: (event) => {
      if (event?.text) console.log(`  ${C.dim}[atlas-v2 scip restage]${C.reset} ${event.text}`);
    },
  });
  if (result.error) {
    console.log(`  ${C.yellow}[atlas-v2 scip restage]${C.reset} ${result.reason || "failed"}: ${result.error}`);
  } else {
    console.log(`  ${C.green}[atlas-v2 scip restage]${C.reset} ${result.reason || "done"} files=${result.files.length}`);
  }
  return result;
}

async function runScipIngest({ projectDir, args }) {
  const parsed = parseScipArgs(args);
  const arg = parsed.targets[0];
  if (!arg) {
    console.log(`  ${C.red}[atlas-v2 scip ingest]${C.reset} usage: posse atlas-v2 scip ingest [--branch <branch>] <path-to-.scip>`);
    return null;
  }
  const scipPath = path.isAbsolute(arg) ? arg : path.resolve(projectDir, arg);
  if (!fileExistsSafe(scipPath)) {
    console.log(`  ${C.red}[atlas-v2 scip ingest]${C.reset} no such file: ${scipPath}`);
    return null;
  }
  const led = openLedgerForCli(projectDir);
  if (!led) return null;
  try {
    let branch;
    try {
      branch = resolveScipBranch(projectDir, led, parsed.branch, {
        explicit: parsed.branchExplicit,
        onWarning: (message) => console.log(`  ${C.yellow}[atlas-v2 scip ingest]${C.reset} warning: ${message}`),
      });
    } catch (err) {
      console.log(`  ${C.red}[atlas-v2 scip ingest]${C.reset} ${formatAtlasError(err)}`);
      return null;
    }
    const result = await ingestScipFile({
      ledger: led,
      scipPath,
      repoRoot: projectDir,
      branch,
      onEvent: (event) => {
        const prefix = `  ${C.green}[atlas-v2 scip ingest]${C.reset}`;
        if (event.kind === "atlas.scip.ingest.skipped") console.log(`${prefix} already up-to-date (${event.scheme})`);
        else if (event.kind === "atlas.scip.ingest.completed") {
          const skipped = event.documents_skipped ? `, skipped=${event.documents_skipped}` : "";
          console.log(`${prefix} ingested ${event.documents_ingested || 0} documents, failed=${event.documents_failed || 0}${skipped}, ${event.external_symbols || 0} externals`);
        } else if (event.kind === "atlas.scip.ingest.failed") {
          console.log(`  ${C.yellow}[atlas-v2 scip ingest]${C.reset} ${event.repo_rel_path}: ${event.message}`);
        } else if (event.kind === "atlas.scip.ingest.warning") {
          console.log(`  ${C.yellow}[atlas-v2 scip ingest]${C.reset} warning: ${event.message}`);
        }
      },
    });
    if (result.skipped) {
      console.log(`  ${C.dim}[atlas-v2 scip ingest]${C.reset} no-op: identical .scip already ingested`);
    } else {
      console.log(`  ${C.green}[atlas-v2 scip ingest]${C.reset} done: id=${result.scip_index_id} docs=${result.documents_ingested} reused=${result.blobs_reused}`);
    }
    return result;
  } finally {
    led.close();
  }
}

async function runScipReparse({ projectDir, args }) {
  const parsed = parseScipArgs(args, { allowLang: true });
  const { langFilter, targets } = parsed;

  /** @type {string[]} */
  let scipFiles = [];
  if (targets.length > 0) {
    scipFiles = targets.map((t) => path.isAbsolute(t) ? t : path.resolve(projectDir, t));
  } else {
    scipFiles = await listScipFiles(scipDir(projectDir));
  }
  if (scipFiles.length === 0) {
    console.log(`  ${C.yellow}[atlas-v2 scip reparse]${C.reset} no .scip files to reparse`);
    return null;
  }

  const led = openLedgerForCli(projectDir);
  if (!led) return null;
  let totalDocs = 0;
  let totalExternals = 0;
  try {
    let branch;
    try {
      branch = resolveScipBranch(projectDir, led, parsed.branch, {
        explicit: parsed.branchExplicit,
        onWarning: (message) => console.log(`  ${C.yellow}[atlas-v2 scip reparse]${C.reset} warning: ${message}`),
      });
    } catch (err) {
      console.log(`  ${C.red}[atlas-v2 scip reparse]${C.reset} ${formatAtlasError(err)}`);
      return null;
    }
    for (const scipPath of scipFiles) {
      if (langFilter && !path.basename(scipPath).toLowerCase().includes(langFilter)) continue;
      try {
        const result = await ingestScipFile({
          ledger: led,
          scipPath,
          repoRoot: projectDir,
          branch,
          force: true,
          onEvent: (event) => {
            if (event.kind === "atlas.scip.ingest.failed") {
              console.log(`  ${C.yellow}[atlas-v2 scip reparse]${C.reset} ${event.repo_rel_path || ""}: ${event.message || ""}`);
            } else if (event.kind === "atlas.scip.ingest.warning") {
              console.log(`  ${C.yellow}[atlas-v2 scip reparse]${C.reset} warning: ${event.message || ""}`);
            }
          },
        });
        totalDocs += result.documents_ingested;
        totalExternals += result.external_symbols;
        console.log(`  ${C.green}[atlas-v2 scip reparse]${C.reset} ${path.basename(scipPath)}: ${result.documents_ingested} docs, ${result.external_symbols} externals`);
      } catch (err) {
        console.log(`  ${C.yellow}[atlas-v2 scip reparse]${C.reset} ${path.basename(scipPath)} failed: ${formatAtlasError(err)}`);
      }
    }
    console.log(`  ${C.green}[atlas-v2 scip reparse]${C.reset} totals: docs=${totalDocs} externals=${totalExternals}`);
    return { totalDocs, totalExternals };
  } finally {
    led.close();
  }
}

function printHelp() {
  console.log(`\n  ${C.bold}posse atlas-v2${C.reset} — operator surface for the v2 ATLAS backend`);
  console.log(`\n  Usage: posse atlas-v2 <subcommand> [args]\n`);
  for (const command of ATLAS_V2_HELP_COMMANDS) {
    console.log(`    ${C.cyan}${command.usage.padEnd(46)}${C.reset} ${command.summary}`);
  }
  console.log("");
}

/**
 * Dispatch the `atlas-v2` command. Pure entry point; no side effects until a
 * subcommand is matched.
 *
 * @param {Object} args
 * @param {string} args.projectDir
 * @param {string[]} args.argv  Positional args after `atlas-v2`.
 */
export async function runAtlasV2Command({ projectDir, argv = [] } = {}) {
  if (!projectDir) throw new Error("runAtlasV2Command requires projectDir");
  const sub = String(argv[0] || "").toLowerCase();
  const rest = argv.slice(1);

  switch (sub) {
    case "":
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return null;
    case "status":
      return printStatus({ projectDir });
    case "rebuild":
      return printRebuild({ projectDir, args: rest });
    case "ledger": {
      const ledgerSub = String(rest[0] || "tail").toLowerCase();
      if (ledgerSub === "tail") return await printLedgerTail({ projectDir, args: rest.slice(1) });
      console.log(`  ${C.red}Unknown ledger subcommand: ${ledgerSub}${C.reset}`);
      console.log("  Available: tail");
      return null;
    }
    case "view": {
      const viewSub = String(rest[0] || "info").toLowerCase();
      if (viewSub === "info") return printViewInfo({ projectDir, args: rest.slice(1) });
      console.log(`  ${C.red}Unknown view subcommand: ${viewSub}${C.reset}`);
      console.log("  Available: info");
      return null;
    }
    case "warm-now":
      return printWarmNow({ projectDir, args: rest });
    case "purge-views":
      return printPurgeViews({ projectDir, args: rest });
    case "models": {
      const modelSub = String(rest[0] || "pull").toLowerCase();
      if (modelSub === "pull") return await runModelsPull({ projectDir, args: rest.slice(1) });
      console.log(`  ${C.red}Unknown models subcommand: ${modelSub}${C.reset}`);
      console.log("  Available: pull");
      return null;
    }
    case "scip": {
      const scipSub = String(rest[0] || "status").toLowerCase();
      const scipArgs = rest.slice(1);
      if (scipSub === "status") return await printScipStatus({ projectDir });
      if (scipSub === "install") return runScipInstall({ args: scipArgs });
      if (scipSub === "restage") return await runScipRestage({ projectDir, args: scipArgs });
      if (scipSub === "ingest") return await runScipIngest({ projectDir, args: scipArgs });
      if (scipSub === "reparse") return await runScipReparse({ projectDir, args: scipArgs });
      console.log(`  ${C.red}Unknown scip subcommand: ${scipSub}${C.reset}`);
      console.log("  Available: status, install, restage, ingest, reparse");
      return null;
    }
    default:
      console.log(`  ${C.red}Unknown atlas-v2 subcommand: ${sub}${C.reset}`);
      printHelp();
      return null;
  }
}
