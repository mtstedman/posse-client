import { C } from "../../../../shared/format/functions/colors.js";
import { TERMINAL_JOB_STATUSES } from "../../../queue/functions/common.js";
import { stripAnsi, fit } from "../../functions/display/helpers/formatters.js";
import { formatDuration } from "../../../../shared/format/functions/units.js";
import { getOnnxWarmState, syntheticOnnxLoadPercent } from "../../../atlas/functions/v2/embeddings/onnx-warm-state.js";
import {
  jobIsBackgroundAtlasWarm,
  workItemDisplayStatus,
  computeJobProgressStats,
  jobReportStatus,
} from "../../functions/display/helpers/job-status.js";
import {
  atlasWarmQueueGroups,
  atlasWarmQueuedEventCount,
  formatAtlasWarmQueueSummary,
} from "../../functions/display/helpers/atlas-warm-rendering.js";

const CONTEXT_HEALTH_LABEL = "Context health";


export class DisplayStatusRenderer {


  // ── Context status bar (thin, full width, above the input) ────────────
  // One always-present line that answers "is code-intelligence healthy right
  // now?": a verdict word + glyph, then the live graph-warm families and the
  // ONNX encoder phase. Derives only from cheap job-row state + the in-memory
  // ONNX warm singleton — no per-frame DB reads. Returns [] (hidden) only when
  // there is genuinely nothing to report (ATLAS idle and encoder never warmed).
  _buildContextStatusBar(width) {
    let groups = [];
    try {
      const { jobs } = this._getQueueData();
      const terminal = new Set(TERMINAL_JOB_STATUSES);
      const warmJobs = (jobs || []).filter(
        (job) => jobIsBackgroundAtlasWarm(job) && !terminal.has(job.status),
      );
      groups = atlasWarmQueueGroups(warmJobs).filter(
        (g) => g.active > 0 || atlasWarmQueuedEventCount(g) > 0,
      );
    } catch {
      groups = [];
    }
    const onnx = getOnnxWarmState();

    const anyRunning = groups.some((g) => g.active > 0);
    const anyQueued = groups.some((g) => atlasWarmQueuedEventCount(g) > 0);

    // Nothing to say: ATLAS idle and the encoder never started.
    if (!anyRunning && !anyQueued && onnx.phase === "idle") return [];

    const halo = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const spin = halo[this._spinIdx % halo.length];

    let glyph;
    let glyphColor;
    let word;
    if (onnx.phase === "failed") {
      glyph = "✗"; glyphColor = C.red; word = "attention";
    } else if (anyRunning || onnx.phase === "loading") {
      glyph = spin; glyphColor = C.cyan; word = "warming";
    } else if (anyQueued) {
      glyph = "·"; glyphColor = C.yellow; word = "queued";
    } else {
      glyph = "✓"; glyphColor = C.green; word = "ready";
    }

    const clauses = [];
    for (const g of groups) {
      const bits = [];
      if (g.active > 0) bits.push(`${g.active}↻`);
      const queued = atlasWarmQueuedEventCount(g);
      if (queued > 0) bits.push(`${queued}⏳`);
      clauses.push(`${C.dim}${g.label}${C.reset} ${bits.join(" ")}`);
    }
    if (onnx.phase === "loading") {
      clauses.push(`${C.cyan}encoder ${syntheticOnnxLoadPercent()}%${C.reset}`);
    } else if (onnx.phase === "ready") {
      clauses.push(`${C.dim}encoder ready${C.reset}`);
    } else if (onnx.phase === "failed") {
      const reason = String(onnx.error || "warm failed").split("\n")[0];
      clauses.push(`${C.red}encoder warm failed${C.reset} ${C.dim}— search is lexical-only (${reason})${C.reset}`);
    }

    const head = `${glyphColor}${glyph} context ${word}${C.reset}`;
    const sep = `${C.dim} · ${C.reset}`;
    // The render loop fit()s every full-width line, trimming the tail (and thus
    // the lower-priority trailing clauses) first while the leading verdict head
    // survives — so we return the line raw and let fit() handle the width.
    const line = clauses.length > 0 ? ` ${head}${sep}${clauses.join(sep)}` : ` ${head}`;
    return [line];
  }



  // ── Progress Bar (full width, top) ────────────────────────────────────

  _buildProgressBar(width) {
    const lines = [];
    try {
      // Only count jobs from visible work items (not complete/canceled)
      const { workItems, jobs } = this._getQueueData();
      const normalJobs = jobs.filter((job) => !jobIsBackgroundAtlasWarm(job));
      const visibleWiIds = new Set();
      for (const wi of workItems) {
        const wiJobs = normalJobs.filter(j => j.work_item_id === wi.id);
        const displayStatus = workItemDisplayStatus(wi, wiJobs);
        if (displayStatus === "canceled") continue;
        if (displayStatus === "complete") continue;
        visibleWiIds.add(wi.id);
      }

      const terminal = new Set(TERMINAL_JOB_STATUSES);
      const allJobs = normalJobs.filter(j => visibleWiIds.has(j.work_item_id));
      const total = allJobs.length;
      if (total === 0) {
        const warmJobs = jobs.filter((job) => jobIsBackgroundAtlasWarm(job) && !terminal.has(job.status));
        if (warmJobs.length > 0) {
          const groups = atlasWarmQueueGroups(warmJobs);
          const summary = groups.map((group) =>
            formatAtlasWarmQueueSummary(group, { activeWord: "running", labelColor: C.cyan }))
            .join(`${C.dim} | ${C.reset}`);
          lines.push(` ${C.cyan}${CONTEXT_HEALTH_LABEL}${C.reset}${C.dim} · ${C.reset}${summary}`);
          return lines;
        }
        if (!Array.isArray(normalJobs) || normalJobs.length === 0) {
          lines.push(` ${C.dim}No jobs yet${C.reset}`);
          return lines;
        }
        const resolved = normalJobs.filter((j) => terminal.has(j.status)).length;
        const completeWIs = workItems.filter((wi) => {
          const wiJobs = normalJobs.filter((j) => j.work_item_id === wi.id);
          return workItemDisplayStatus(wi, wiJobs) === "complete";
        });
        const pendingMerges = completeWIs.filter((wi) => wi.branch_name && wi.merge_state !== "merged").length;
        const merged = completeWIs.filter((wi) => wi.merge_state === "merged").length;
        const phase = this._runPhaseMessage || (pendingMerges > 0
          ? `${pendingMerges} pending merge${pendingMerges === 1 ? "" : "s"}`
          : "wrap-up");
        const parts = [
          `${C.green}All jobs complete${C.reset}`,
          `${C.bold}${resolved}${C.reset}${C.dim}/${normalJobs.length} done${C.reset}`,
        ];
        if (merged > 0) parts.push(`${C.bold}${merged}${C.reset}${C.dim} merged${C.reset}`);
        parts.push(`${C.dim}${phase}${C.reset}`);
        lines.push(` ${parts.join(`${C.dim} · ${C.reset}`)}`);
        return lines;
      }

      const {
        failed,
        running,
        queued,
        assessing,
        resolved,
        fraction,
      } = computeJobProgressStats(allJobs);

      // Build stats string — show resolved/total so bar matches
      const parts = [`${resolved}/${total}`];
      if (running > 0) parts.push(`${C.cyan}${running} running${C.reset}`);
      if (assessing > 0) parts.push(`${C.cyan}${assessing} assessing${C.reset}`);
      if (queued > 0) parts.push(`${C.blue}${queued} queued${C.reset}`);
      if (failed > 0) parts.push(`${C.red}${failed} failed${C.reset}`);
      const statsStr = parts.join("  ");
      const statsVisible = stripAnsi(statsStr);

      // Progress bar fills remaining width — fraction tracks resolved (terminal) jobs
      const barW = Math.max(width - statsVisible.length - 4, 15);
      const fullBlocks = Math.floor(fraction * barW);
      const partials = [" ", "\u258f", "\u258e", "\u258d", "\u258c", "\u258b", "\u258a", "\u2589", "\u2588"];
      const remainder = (fraction * barW) - fullBlocks;
      const partialChar = fullBlocks < barW ? partials[Math.round(remainder * 8)] : "";
      const emptyBlocks = Math.max(barW - fullBlocks - (partialChar && partialChar !== " " ? 1 : 0), 0);
      const bar = `${C.green}${"\u2588".repeat(fullBlocks)}${partialChar}${C.reset}${C.dim}${"\u2591".repeat(emptyBlocks)}${C.reset}`;

      lines.push(` ${bar} ${statsStr}`);
    } catch {
      lines.push(` ${C.dim}Loading...${C.reset}`);
    }
    return lines;
  }



  // ── Run clock: `⏱  14:32  ·  elapsed 3m 12s  ·  4 WI  ·  12 done` ───────
  _buildRunClockLine(width) {
    const startedIso = this._runStartedAtIso;
    if (!startedIso) return null;
    const startedAt = Date.parse(startedIso);
    if (!Number.isFinite(startedAt)) return null;

    const startHHMM = new Date(startedAt).toTimeString().slice(0, 5);
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const elapsed = formatDuration(elapsedMs);

    let wiTotal = 0;
    let jobsDone = 0;
    try {
      const { workItems, jobs } = this._getQueueData();
      wiTotal = Array.isArray(workItems) ? workItems.length : 0;
      const TERMINAL = new Set(["succeeded", "recovered"]);
      jobsDone = Array.isArray(jobs)
        ? jobs.filter((j) => TERMINAL.has(jobReportStatus(j, jobs))).length
        : 0;
    } catch { /* best effort */ }

    const sep = `${C.dim} · ${C.reset}`;
    const parts = [
      `${C.dim}⏱${C.reset}  ${C.bold}${startHHMM}${C.reset}`,
      `${C.dim}elapsed${C.reset} ${C.bold}${elapsed}${C.reset}`,
      `${C.bold}${wiTotal}${C.reset}${C.dim} WI${C.reset}`,
      `${C.bold}${jobsDone}${C.reset}${C.dim} done${C.reset}`,
    ];
    return fit(` ${parts.join(sep)}`, Math.max(1, width - 1));
  }
}
