import { C } from "../../../../shared/format/functions/colors.js";
import { tierModelName } from "../../../providers/functions/provider.js";
import { TERMINAL_JOB_STATUSES } from "../../../queue/functions/common.js";
import { stripAnsi, _sanitizeDisplayLine } from "../../functions/display/helpers/formatters.js";
import { roleBrandColor, readinessGauge, brandRule } from "../../functions/display/helpers/brand.js";
import { getWarmReadiness } from "../../../atlas/functions/v2/warm-progress.js";
import { describeAtlasWarmJob } from "../../../atlas/functions/v2/process-indicators.js";
import {
  JOB_TYPE_ABBR,
  JOB_TYPE_COLORS_KEY,
  jobLabel,
  jobDisplayStatus,
  jobIsDisplayFailure,
  jobIsBackgroundAtlasWarm,
  workItemDisplayStatus,
} from "../../functions/display/helpers/job-status.js";
import {
  getProviderUsageSummaryCache,
  _buildQueueProviderUsageLines,
} from "../../functions/display/helpers/provider-usage.js";
import { atlasWarmStatusWords } from "../../functions/display/helpers/atlas-warm-rendering.js";



function queueRowsRequiredForPendingCap(items = [], pendingCap = 0) {
  let rows = 0;
  for (const item of items) {
    if (item.allDone) {
      rows += 1;
      continue;
    }
    rows += 1; // WI header
    rows += item.activeJobs.length;
    const pendingShown = Math.min(item.pendingJobs.length, pendingCap);
    rows += pendingShown;
    if (item.pendingJobs.length > pendingShown) rows += 1;
    if (item.doneCount > 0) rows += 1;
  }
  return rows;
}



function queuePendingCapForVisibleItems(items = [], rowBudget = 0) {
  const maxPending = Math.max(0, ...items.map((item) => item.pendingJobs.length));
  let cap = 0;
  for (let candidate = 0; candidate <= maxPending; candidate++) {
    if (queueRowsRequiredForPendingCap(items, candidate) > rowBudget) break;
    cap = candidate;
  }
  return cap;
}



function queueJobDisplayState(job, { active = false } = {}) {
  const status = String(job?.status || "").toLowerCase();
  if (active || status === "running" || status === "leased") return "running";
  if (status === "awaiting_assessment") return "assessing";
  if (status === "waiting_on_human" || (job?.job_type === "human_input" && status !== "succeeded")) return "input";
  if (status === "waiting_on_review") return "review";
  if (status === "blocked") return "blocked";
  if (status === "queued") return "queued";
  return status || "pending";
}



const QUEUE_JOB_STATE_LABELS = {
  running: { label: "running", color: C.cyan },
  assessing: { label: "assessing", color: C.cyan },
  queued: { label: "queued", color: C.blue },
  blocked: { label: "blocked", color: C.yellow },
  input: { label: "needs input", color: C.yellow },
  review: { label: "needs review", color: C.magenta },
  pending: { label: "pending", color: C.dim },
};



const QUEUE_JOB_STATE_ORDER = ["running", "assessing", "queued", "blocked", "input", "review", "pending"];



function formatQueueJobStateSummary(jobs = [], jobStates = null) {
  const counts = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const state = jobStates?.get(Number(job?.id)) || queueJobDisplayState(job);
    counts.set(state, (counts.get(state) || 0) + 1);
  }
  const orderedStates = [
    ...QUEUE_JOB_STATE_ORDER,
    ...[...counts.keys()].filter((state) => !QUEUE_JOB_STATE_ORDER.includes(state)).sort(),
  ];
  return orderedStates
    .filter((state) => counts.has(state))
    .map((state) => {
      const meta = QUEUE_JOB_STATE_LABELS[state] || QUEUE_JOB_STATE_LABELS.pending;
      const count = counts.get(state);
      return `${meta.color}${count} ${meta.label}${C.reset}`;
    })
    .join(`${C.dim}, ${C.reset}`);
}



function formatQueueWiHeader(prefix, title, inner) {
  const text = _sanitizeDisplayLine(title || "");
  if (!text) return prefix;
  const titleBudget = Math.max(0, inner - stripAnsi(prefix).length - 1);
  if (titleBudget <= 0) return prefix;
  return `${prefix} ${text.slice(0, titleBudget)}`;
}



function formatQueueJobTitle(title, maxWidth, siblingTitles = []) {
  const text = _sanitizeDisplayLine(title || "");
  const width = Math.max(0, Number(maxWidth || 0));
  if (width <= 0) return "";
  if (text.length <= width) return text;

  const clippedHead = text.slice(0, width);
  const matchingSiblings = siblingTitles
    .map((other) => _sanitizeDisplayLine(other || ""))
    .filter((otherText) => (
      otherText !== text
      && otherText.length > width
      && otherText.slice(0, width) === clippedHead
    ));
  const hasSameVisiblePrefix = matchingSiblings.length > 0;
  if (!hasSameVisiblePrefix || width < 14) return clippedHead;

  const marker = "…";
  const commonPrefixLength = (left, right) => {
    const limit = Math.min(left.length, right.length);
    let i = 0;
    while (i < limit && left[i] === right[i]) i++;
    return i;
  };
  const commonSuffixLength = (left, right, prefixLimit) => {
    const max = Math.min(left.length, right.length) - prefixLimit;
    let i = 0;
    while (i < max && left[left.length - 1 - i] === right[right.length - 1 - i]) i++;
    return i;
  };
  const stripLeadingFiller = (value) => String(value || "")
    .replace(/^[\s:;,.()[\]{}"'`<>/\\|+\-=]+/, "")
    .replace(/^(?:and|or|in|for|to|with|from|of|the|a|an)\s+/i, "");

  let bestSnippet = "";
  for (const otherText of matchingSiblings) {
    const prefixLen = commonPrefixLength(text, otherText);
    const suffixLen = commonSuffixLength(text, otherText, prefixLen);
    const differingEnd = Math.max(prefixLen, text.length - suffixLen);
    const snippet = stripLeadingFiller(text.slice(prefixLen, differingEnd));
    if (snippet.length > bestSnippet.length) bestSnippet = snippet;
  }
  if (bestSnippet) {
    const headWidth = Math.max(6, Math.min(Math.floor(width * 0.48), width - marker.length - 4));
    const snippetWidth = Math.max(4, width - marker.length - headWidth);
    return `${text.slice(0, headWidth)}${marker}${bestSnippet.slice(0, snippetWidth)}`;
  }

  const hasSharedPrefix = siblingTitles.some((other) => {
    const otherText = _sanitizeDisplayLine(other || "");
    return otherText !== text && otherText.length > width && otherText.slice(0, width) === clippedHead;
  });
  if (!hasSharedPrefix) return clippedHead;

  const headWidth = Math.max(6, Math.floor((width - marker.length) * 0.55));
  const tailWidth = Math.max(4, width - marker.length - headWidth);
  return `${text.slice(0, headWidth)}${marker}${text.slice(-tailWidth)}`;
}

export class DisplayLeftPanelRenderer {


  // ── Left Panel: Workers + Queue ───────────────────────────────────────

  _blockedLockSummaryLabels(limitCount = null) {
    const details = Array.isArray(this._blockedByLockDetails) ? this._blockedByLockDetails.filter(Boolean) : [];
    const counts = { worktreeCap: 0, serialization: 0, fileLock: 0 };
    for (const detail of details) {
      if (detail.holder_type === "worktree_cap") counts.worktreeCap++;
      else if (detail.holder_type === "worktree_serialization") counts.serialization++;
      else counts.fileLock++;
    }
    if (details.length === 0 && Number(this._blockedByLock || 0) > 0) {
      counts.fileLock = Number(this._blockedByLock || 0);
    }
    const labels = [];
    if (counts.worktreeCap > 0) labels.push(`${counts.worktreeCap} queued for worktree slot${counts.worktreeCap === 1 ? "" : "s"}`);
    if (counts.fileLock > 0) labels.push(`${counts.fileLock} waiting on file lock${counts.fileLock === 1 ? "" : "s"}`);
    if (counts.serialization > 0) labels.push(`${counts.serialization} waiting on serialization`);
    if (limitCount != null && details.length > 0 && limitCount > details.length) {
      labels.push(`${limitCount - details.length} more waiting`);
    }
    if (limitCount != null && labels.length === 0 && limitCount > 0) {
      labels.push(`${limitCount} waiting on file lock${limitCount === 1 ? "" : "s"}`);
    }
    return labels;
  }



  _buildLeft(width, maxLines) {

    // ── Workers ──
    const workers = [];
    const halo = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
    const spin = halo[this._spinIdx % halo.length];
    const countTag = `${C.dim}${this.workers.size}/${this.concurrency}${C.reset}`;
    const rule = "\u2501".repeat(Math.max(width - 14, 5));
    workers.push(` ${C.bold}Workers${C.reset} ${C.dim}${rule}${C.reset} ${countTag}`);

    for (const [jobId, w] of this.workers) {
      const elapsed = ((Date.now() - w.startTime) / 1000).toFixed(0);
      const isWaiting = this._questionQueue.some(q => q.jobId === jobId);
      const c = roleBrandColor(w.role);

      // `\u258e` accent bar in role color makes each active worker scannable
      // even when the spinner ticks change. Waiting workers go yellow.
      const accent = isWaiting ? `${C.yellow}\u258e${C.reset}` : `${c}\u258e${C.reset}`;
      const wiRefColor = w.role === "researcher" ? c : C.blue;
      const wiPlain = (w.workItemId ? `WI#${w.workItemId}` : `#${jobId}`).padEnd(7);
      const wiCol = w.workItemId
        ? `${wiRefColor}${wiPlain}${C.reset}`
        : `${C.dim}${wiPlain}${C.reset}`;
      if (isWaiting) {
        workers.push(`${accent} ${C.yellow}${spin}${C.reset} ${this._roleTag(w.role)} ${wiCol} ${C.yellow}\u26a0 waiting${C.reset}`);
      } else {
        const tierColors = { cheap: C.dim, standard: C.cyan, strong: C.magenta };
        const effortAbbr = { low: "low", medium: "med", high: "high" };
        const modelLabel = w.modelName || tierModelName(w.tier, { providerName: w.provider, role: w.role });
        // Truncate model name to a stable 14-char column so trailing fields stay aligned
        const modelShort = modelLabel.length > 14 ? `${modelLabel.slice(0, 13)}\u2026` : modelLabel;
        const modelPadded = modelShort.padEnd(14);
        const tierTag = `${tierColors[w.tier] || C.dim}${modelPadded}${C.reset}`;
        const effortTag = `${C.dim}${(effortAbbr[w.effort] || w.effort || "").padEnd(4)}${C.reset}`;
        const attemptTag = w.attempt > 1 ? ` ${C.yellow}a${w.attempt}${C.reset}` : "";
        const stateTag = w.booting
          ? this._describeWorkerBootState(w)
          : `${C.dim}${String(elapsed).padStart(4)}s${C.reset}`;
        workers.push(`${accent} ${c}${spin}${C.reset} ${this._roleTag(w.role)} ${wiCol} ${tierTag} ${effortTag}${attemptTag} ${stateTag}`);
      }
    }

    // Idle slots — distinguish between truly idle and blocked-by-file-lock
    const openSlots = this.concurrency - this.workers.size;
    const blockedByLock = Math.min(this._blockedByLock || 0, openSlots);
    const trulyIdle = openSlots - blockedByLock;
    if (blockedByLock > 0) {
      const labels = this._blockedLockSummaryLabels(blockedByLock);
      workers.push(`  ${C.yellow}\u00b7 ${labels.join(", ")}${C.reset}`);
    }
    if (trulyIdle > 0) {
      workers.push(`  ${C.dim}\u00b7 ${trulyIdle} idle${C.reset}`);
    }

    // ── ONNX encoder warm state ──
    // The encoder warm no longer rides as a stray chip in the workers list —
    // it's reported by the ATLAS/ONNX readiness bars below (see
    // _buildAtlasReadinessLines), alongside the graph-warm verdict, so the whole
    // code-intelligence picture reads in one place.

    // ── Queue (fills remaining space) ──
    const footerLineBudget = Math.min(Math.max(0, maxLines - workers.length - 3), 9);
    const activeProviders = new Set(
      [...this.workers.values()]
        .map((worker) => String(worker?.provider || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const providerUsageCache = getProviderUsageSummaryCache();
    const footerLines = footerLineBudget >= 4
      ? _buildQueueProviderUsageLines(width, footerLineBudget, providerUsageCache.summaries || [], {
        activeProviders,
        currentRunProviderUsage: providerUsageCache.currentRunProviderUsage || [],
        runStartedAtIso: this._runStartedAtIso,
      })
      : [];
    // ── Code-intelligence readiness bars (ATLAS + ONNX), above the queue ──
    const readinessLines = (maxLines - workers.length - footerLines.length) >= 6
      ? this._buildAtlasReadinessLines()
      : [];
    // Brand-rule headers bracket the two sections: "context health" over the
    // readiness bars, "queue" over the work-item list (the rule replaces the old
    // plain divider AND the inline bold "Queue" header).
    const readinessHeader = readinessLines.length > 0 ? 1 : 0;
    const queueBudget = Math.max(maxLines - workers.length - 1 - readinessHeader - footerLines.length - readinessLines.length, 2); // -1 for the queue rule
    const queue = this._buildQueue(width, queueBudget);

    // ── Assemble ──
    const lines = [];
    lines.push(...workers);
    if (readinessLines.length > 0) {
      lines.push(brandRule({ label: "context health", color: C.cyan, width }));
      lines.push(...readinessLines);
    }
    lines.push(brandRule({ label: "queue", color: C.cyan, width })); // header + separator above queue
    lines.push(...queue);
    if (footerLines.length > 0) {
      const paddingLines = Math.max(0, maxLines - lines.length - footerLines.length);
      for (let i = 0; i < paddingLines; i++) lines.push("");
      lines.push(...footerLines);
    }

    return lines;
  }



  /**
   * Two live code-intelligence readiness bars (ATLAS composite + ONNX) for the
   * left panel, above the queue. Fed by the conductor's streamed warm progress
   * and seeded from the boot warm's real result (see warm-progress.js): they
   * fill while a warm runs and rest at "ready"/"incomplete". "off" is reserved
   * for genuinely-disabled-by-config; "not ready" means nothing has been
   * observed yet this session.
   */
  _buildAtlasReadinessLines() {
    let r;
    try { r = getWarmReadiness(); } catch { return []; }
    // Ease the displayed fill toward its target each frame so even a sub-second
    // incremental warm shows a visible sweep instead of snapping idle→ready. Eases
    // UP only; snaps down (a new warm cycle resets the target to ~0, and idle/off
    // resets to 0) so the bar never visibly reverses.
    if (!this._readinessAnim) this._readinessAnim = { atlas: 0, onnx: 0 };
    const ease = (key, target, known) => {
      if (!known) { this._readinessAnim[key] = 0; return 0; }
      const cur = this._readinessAnim[key] ?? 0;
      const next = target <= cur
        ? target
        : Math.min(target, cur + Math.max(3, (target - cur) * 0.34));
      this._readinessAnim[key] = next;
      return next;
    };
    const pctStr = (n) => `${String(Math.round(n)).padStart(3)}%`;
    // Leading status glyph + rest-label color per row, so the bar's state reads
    // at a glance: active sweep, finished, didn't-finish, or never-ran.
    //   active → forward caret (bar color)   ready  → check (green)
    //   off / idle → dim dot                 partial→ "!" (yellow, honest)
    const rowState = (color, known, active, pct, off) => {
      // off/never-ran wins over active: an idle ONNX bar shouldn't show a sweep
      // caret just because ATLAS is warming.
      if (off || !known) return { glyph: `${C.dim}·${C.reset}`, restColor: C.dim };
      if (active) return { glyph: `${color}▸${C.reset}`, restColor: C.bold };
      if (pct >= 100) return { glyph: `${C.green}✓${C.reset}`, restColor: C.green };
      return { glyph: `${C.yellow}!${C.reset}`, restColor: C.yellow };
    };
    const row = (key, label, color, target, known, right, off = false) => {
      const shown = ease(key, target, known);
      const g = readinessGauge(known && !off ? shown : null, { width: 16, color });
      const st = rowState(color, known, r.active, target ?? 0, off);
      return ` ${st.glyph} ${color}${label.padEnd(5)}${C.reset} ${g.bar} ${st.restColor}${right}${C.reset}`;
    };
    // Resting label: "ready" (fully warmed) / "incomplete" (warm didn't
    // finish) / "not ready" (nothing observed yet this session — e.g. boot
    // failed before seeding). Active → live % + the language/stage worked.
    const restLabel = (pct) => pct == null ? "not ready" : (pct >= 100 ? "ready" : "incomplete");
    // "off" only when config genuinely disables the subsystem (seeded at boot
    // from real settings) — never inferred from "no percent observed yet".
    const atlasOff = r.atlasEnabled === false;
    const onnxOff = atlasOff || r.onnxEnabled === false;
    // ATLAS composite (scip + tree-sitter + view-merge).
    const atlasRight = atlasOff
      ? "off"
      : (r.active
        ? `${pctStr(r.atlas ?? 0)} ${r.lang || r.stage || ""}`.trimEnd()
        : restLabel(r.atlas));
    // ONNX (embeddings).
    const onnxRight = onnxOff
      ? "off"
      : (r.active && r.onnx != null ? pctStr(r.onnx) : restLabel(r.onnx));
    return [
      row("atlas", "ATLAS", C.cyan, r.atlas ?? 0, r.atlas != null || r.active, atlasRight, atlasOff),
      row("onnx", "ONNX", C.magenta, r.onnx ?? 0, r.onnx != null, onnxRight, onnxOff),
    ];
  }



  _buildQueue(width, maxLines) {
    const lines = [];
    const inner = width - 1;

    try {
      const { workItems, jobs: allJobs, dirtyState = null } = this._getQueueData();
      // Background ATLAS warm jobs are reported by the context-health readiness
      // bars (see _buildAtlasReadinessLines), not as queue rows, so the queue
      // shows only normal work-item jobs.
      const normalJobs = allJobs.filter((job) => !jobIsBackgroundAtlasWarm(job));
      const jobsByWi = new Map();
      for (const job of normalJobs) {
        if (!jobsByWi.has(job.work_item_id)) jobsByWi.set(job.work_item_id, []);
        jobsByWi.get(job.work_item_id).push(job);
      }

      // Active job IDs (for highlighting)
      const activeJobIds = new Set();
      for (const [jobId] of this.workers) activeJobIds.add(jobId);

      const TERMINAL = new Set(TERMINAL_JOB_STATUSES);
      const dirtyReviewByWi = this._dirtyReviewIssuesByWi(dirtyState);
      const dirtyReviewForWi = (wi) => {
        if (String(wi?.merge_state || "").toLowerCase() === "merged") return null;
        return dirtyReviewByWi.get(Number(wi?.id)) || null;
      };

      // Hide only truly finished WIs. If a follow-up recommendation job was
      // queued against a previously-complete WI, trust live job state here
      // rather than stale work_item.status so it still shows in the queue.
      const visible = workItems.filter(wi => {
        const jobs = jobsByWi.get(wi.id) || [];
        if (dirtyReviewForWi(wi)) return true;
        const displayStatus = workItemDisplayStatus(wi, jobs);
        if (displayStatus === "canceled") return false;
        if (jobs.length === 0) return displayStatus !== "complete";
        if (displayStatus === "complete") return false;
        return !jobs.every((job) => TERMINAL.has(job.status));
      });
      const hidden = workItems.length - visible.length;
      // The "queue" brand-rule header is emitted by the panel assembler above
      // (alongside the "context health" rule over the readiness bars), so no
      // inline header is pushed here.

      const visibleItems = visible.map((wi) => {
        const jobs = jobsByWi.get(wi.id) || [];
        const dirtyReview = dirtyReviewForWi(wi);
        const done = jobs.filter(j => TERMINAL.has(j.status)).length;
        const wiFailed = jobs.filter(j => jobIsDisplayFailure(j, jobs)).length;
        const allDone = jobs.length > 0 && done === jobs.length;
        const activeJobs = [];
        const pendingJobs = [];
        const jobStates = new Map();
        let doneCount = 0;
        let failedCount = 0;

        for (const j of jobs) {
          const isActive = activeJobIds.has(j.id);
          const state = queueJobDisplayState(j, { active: isActive });
          jobStates.set(Number(j.id), state);
          if (state === "running" || state === "assessing") {
            activeJobs.push(j);
          } else if (TERMINAL.has(j.status)) {
            doneCount++;
            if (jobIsDisplayFailure(j, jobs)) failedCount++;
          } else {
            pendingJobs.push(j);
          }
        }

        return {
          wi,
          jobs,
          done,
          wiFailed,
          allDone,
          allPassed: allDone && wiFailed === 0,
          activeJobs,
          pendingJobs,
          jobStates,
          queueJobLabels: jobs.map((job) => jobLabel(job.job_type, job.title)),
          doneCount,
          failedCount,
          dirtyReview,
        };
      });
      const pendingJobCap = queuePendingCapForVisibleItems(
        visibleItems,
        Math.max(maxLines - lines.length, 0)
      );

      for (let wiIdx = 0; wiIdx < visibleItems.length; wiIdx++) {
        const {
          wi,
          jobs,
          done,
          wiFailed,
          allDone,
          allPassed,
          activeJobs,
          pendingJobs,
          jobStates,
          queueJobLabels,
          doneCount,
          failedCount,
          dirtyReview,
        } = visibleItems[wiIdx];
        if (lines.length >= maxLines - 1) {
          const remaining = visibleItems.length - wiIdx;
          // A prior work-item block can push us to (or past) the budget, so drop
          // any trailing detail rows before appending the tally. Otherwise the
          // "... N more" line overruns maxLines and the panel assembler clips a
          // line off the bottom — which is the pinned provider/codex usage footer.
          while (lines.length > maxLines - 1) lines.pop();
          lines.push(` ${C.dim}... ${remaining} more${C.reset}`);
          break;
        }

        // All done — single collapsed line
        if (allDone) {
          const icon = allPassed ? `${C.green}\u2713` : `${C.red}\u2717`;
          const failTag = wiFailed > 0 ? ` ${C.red}${wiFailed} failed${C.reset}${C.dim}` : "";
          const reviewTag = dirtyReview ? ` ${C.yellow}needs review${C.reset}${C.dim}` : "";
          const dirtyTag = dirtyReview ? `, ${dirtyReview.label}` : "";
          const prefix = ` ${icon}${C.reset} ${C.dim}WI#${wi.id} (${done}/${jobs.length}${failTag}${dirtyTag})${reviewTag}${C.reset}`;
          lines.push(formatQueueWiHeader(prefix, wi.title, inner));
          continue;
        }

        // WI header — surface failure count so partial failures aren't hidden
        const headerFail = wiFailed > 0 ? ` ${C.red}${wiFailed}\u2717${C.reset}${C.dim}` : "";
        const dirtyTag = dirtyReview ? `${C.dim} · ${dirtyReview.label}${C.reset}` : "";
        const liveSummary = formatQueueJobStateSummary([...activeJobs, ...pendingJobs], jobStates);
        const liveTag = liveSummary ? ` ${liveSummary}` : "";
        const reviewTag = dirtyReview && activeJobs.length === 0 && pendingJobs.length === 0
          ? ` ${C.yellow}needs review${C.reset}`
          : "";
        const prefix = ` ${C.blue}WI#${wi.id}${C.reset} ${C.dim}(${done}/${jobs.length}${headerFail}${C.dim})${C.reset}${liveTag}${dirtyTag}${reviewTag}`;
        lines.push(formatQueueWiHeader(prefix, "", inner));

        // Show running jobs with glow
        for (const j of activeJobs) {
          if (lines.length >= maxLines) break;
          const runTag = this._jobRunningTag(j);
          const tc = C[JOB_TYPE_COLORS_KEY[j.job_type]] || C.dim;
          const glowOn = Math.floor(this._spinIdx / 3) % 2 === 0;
          const glow = glowOn ? `${C.bold}${C.brightWhite}` : `${C.bold}${tc}`;
          const jobRef = `${C.dim}#${j.id}${C.reset}`;
          // Budget the title around the status tag so long tags (e.g. ATLAS
          // warm details) shrink the title instead of overflowing the row.
          const statusTag = this._jobStatusTag(j);
          const tagWidth = statusTag ? stripAnsi(statusTag).length : 0;
          const jTitle = formatQueueJobTitle(jobLabel(j.job_type, j.title), Math.max(12, inner - 20 - tagWidth), queueJobLabels);
          lines.push(`  ${runTag} ${jobRef} ${glow}${jTitle}${C.reset}${statusTag}`);
        }

        const maxPending = Math.min(
          pendingJobs.length,
          Math.max(pendingJobCap, 0)
        );
        for (let i = 0; i < maxPending; i++) {
          if (lines.length >= maxLines) break;
          const j = pendingJobs[i];
          const icon = this._jobIcon(j, false, jobs);
          const tc = C[JOB_TYPE_COLORS_KEY[j.job_type]] || C.dim;
          const typeTag = `${tc}[${JOB_TYPE_ABBR[j.job_type] || j.job_type[0].toUpperCase()}]${C.reset}`;
          const jobRef = `${C.dim}#${j.id}${C.reset}`;
          const statusTag = this._jobStatusTag(j);
          const tagWidth = statusTag ? stripAnsi(statusTag).length : 0;
          const jTitle = formatQueueJobTitle(jobLabel(j.job_type, j.title), Math.max(12, inner - 20 - tagWidth), queueJobLabels);
          lines.push(`  ${icon}${C.reset} ${typeTag} ${jobRef} ${jTitle}${statusTag}`);
        }
        if (pendingJobs.length > maxPending) {
          const hiddenJobs = pendingJobs.slice(maxPending);
          const hiddenSummary = formatQueueJobStateSummary(hiddenJobs, jobStates);
          lines.push(`  ${C.dim}  + ${hiddenSummary || `${hiddenJobs.length} pending`} hidden${C.reset}`);
        }

        // Summary line for done jobs
        if (doneCount > 0) {
          const failStr = failedCount > 0 ? `, ${C.red}${failedCount} failed${C.reset}${C.dim}` : "";
          lines.push(`  ${C.dim}\u2713 ${doneCount} done${failStr}${C.reset}`);
        }
      }
      if (hidden > 0) {
        lines.push(` ${C.dim}${hidden} merged/done${C.reset}`);
      }
    } catch {
      lines.push(` ${C.dim}(loading...)${C.reset}`);
    }

    // Honor the budget unconditionally: the per-work-item body pushes a few rows
    // ("+N hidden", done summaries) without re-checking, so the last block can
    // overshoot. Returning more than maxLines lets the assembler clip the pinned
    // footer off the bottom of the panel.
    if (lines.length > maxLines) lines.length = maxLines;

    return lines;
  }



  _jobIcon(j, isActive, jobs = []) {
    if (isActive || j.status === "running") return null; // handled by _jobRunningTag
    const displayStatus = jobDisplayStatus(j, jobs);
    if (displayStatus === "succeeded") return `${C.green}\u2713`;
    if (displayStatus === "recovered") return `${C.yellow}\u21bb`;
    if (j.status === "awaiting_assessment") return `${C.cyan}\u2026`;
    if (displayStatus === "failed" || displayStatus === "dead_letter") return `${C.red}\u2717`;
    if (j.status === "waiting_on_human" || (j.job_type === "human_input" && j.status !== "succeeded")) return `${C.yellow}\u26a0`;
    if (j.status === "waiting_on_review") return `${C.magenta}?`;
    if (j.status === "blocked") return `${C.yellow}\u2016`;
    if (j.status === "queued") return `${C.blue}\u25cb`;
    return `${C.dim}~`;
  }



  /** Build a snake-wrapped role tag for running jobs, e.g. ⠋[D]⠁ */
  _jobRunningTag(j) {
    // 3-dot snake traces a rectangular path (clockwise) around the [X] tag.
    // Path: L.dot1 → L.dot4 → R.dot1 → R.dot4 → R.dot5 → R.dot6 → R.dot3 → L.dot6 → L.dot3 → L.dot2
    // Each frame is [left_braille, right_braille] showing 3 consecutive positions on the rectangle.
    const frames = [
      ["\u2807", "\u2800"],  // ⠇ ⠀  — left side (dots 1,2,3)
      ["\u280b", "\u2800"],  // ⠋ ⠀  — turning top-left corner (dots 1,2,4)
      ["\u2809", "\u2801"],  // ⠉ ⠁  — across top-left (dots 1,4 | dot 1)
      ["\u2808", "\u2809"],  // ⠈ ⠉  — across top-right (dot 4 | dots 1,4)
      ["\u2800", "\u2819"],  // ⠀ ⠙  — turning top-right corner (dots 1,4,5)
      ["\u2800", "\u2838"],  // ⠀ ⠸  — right side (dots 4,5,6)
      ["\u2800", "\u2834"],  // ⠀ ⠴  — turning bottom-right corner (dots 3,5,6)
      ["\u2820", "\u2824"],  // ⠠ ⠤  — across bottom-right (dot 6 | dots 3,6)
      ["\u2824", "\u2804"],  // ⠤ ⠄  — across bottom-left (dots 3,6 | dot 3)
      ["\u2826", "\u2800"],  // ⠦ ⠀  — turning bottom-left corner (dots 2,3,6)
    ];
    const [l, r] = frames[this._spinIdx % frames.length];
    const tc = C[JOB_TYPE_COLORS_KEY[j.job_type]] || C.dim;
    const letter = JOB_TYPE_ABBR[j.job_type] || j.job_type[0].toUpperCase();
    return `${C.cyan}${l}${C.reset}${tc}[${letter}]${C.reset}${C.cyan}${r}${C.reset}`;
  }



  _jobStatusTag(j) {
    if (j.job_type === "atlas_warm") return this._atlasWarmStatusTag(j);
    if (j.status === "waiting_on_human") return ` ${C.yellow}needs input${C.reset}`;
    if (j.status === "waiting_on_review") return ` ${C.magenta}needs review${C.reset}`;
    if (j.job_type === "human_input" && ["running", "queued"].includes(j.status)) return ` ${C.yellow}input needed${C.reset}`;
    if (j.status === "awaiting_assessment") return ` ${C.cyan}assessing${C.reset}`;
    return "";
  }



  _atlasWarmStatusTag(j) {
    const info = describeAtlasWarmJob(j);
    const paths = info.paths > 0 ? ` ${info.paths} path${info.paths === 1 ? "" : "s"}` : "";
    const label = `${info.purpose} ${info.target}${paths}`;
    const words = atlasWarmStatusWords(info);
    if (j.status === "running" || j.status === "leased") return ` ${C.cyan}${words.active} ${label}${C.reset}`;
    if (j.status === "queued" || j.status === "blocked") return ` ${C.blue}${words.queued} ${label}${C.reset}`;
    if (j.status === "failed" || j.status === "dead_letter") return ` ${C.red}${words.failed} ${label}${C.reset}`;
    if (j.status === "succeeded") return ` ${C.green}${words.succeeded} ${label}${C.reset}`;
    return ` ${C.dim}${label}${C.reset}`;
  }



  _dirtyReviewIssuesByWi(dirtyState = null) {
    const byWi = new Map();
    const dirtyItems = Array.isArray(dirtyState?.dirtyItems) ? dirtyState.dirtyItems : [];
    for (const item of dirtyItems) {
      const wiId = Number(item?.wiId ?? item?.work_item_id);
      if (!Number.isFinite(wiId)) continue;
      const issues = Array.isArray(item?.issues) ? item.issues : [];
      const manualIssues = issues.filter((issue) =>
        ["dirty", "stash", "orphan", "orphan_ref"].includes(String(issue?.type || "")));
      if (manualIssues.length === 0) continue;
      const dirtyIssue = manualIssues.find((issue) => issue.type === "dirty");
      const dirtyCount = dirtyIssue?.files
        ? String(dirtyIssue.files).split("\n").filter(Boolean).length
        : 0;
      const stashIssue = manualIssues.find((issue) => issue.type === "stash");
      const orphanIssue = manualIssues.find((issue) => issue.type === "orphan" || issue.type === "orphan_ref");
      const parts = [
        dirtyCount > 0 ? `${dirtyCount} dirty` : dirtyIssue ? "dirty" : null,
        stashIssue ? "stash" : null,
        orphanIssue ? "orphan" : null,
      ].filter(Boolean);
      byWi.set(wiId, {
        item,
        issues: manualIssues,
        label: parts.length > 0 ? parts.join(", ") : "dirty tree",
      });
    }
    return byWi;
  }
}
