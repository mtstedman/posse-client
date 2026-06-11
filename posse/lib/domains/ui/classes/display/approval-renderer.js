// lib/display.js - Split-screen terminal UI with input handling
//
// Layout:
//   Top:     Progress bar (full width, glued)
//   Middle:  Workers + Queue (left) | Event log (right)
//   Bottom:  Input prompt / Questions / Kill menu / Hints (full width)
//
// Uses the alternate screen buffer so the TUI never pollutes scrollback.
// Supports raw stdin keypress input for questions, inject, kill commands.

import readline from "readline";
import { C } from "../../../providers/functions/claude.js";
import { statusColor as paletteStatusColor } from "../../functions/display/status-palette.js";
import { tierModelName } from "../../../providers/functions/provider.js";
import { FAILED_JOB_STATUSES } from "../../../queue/functions/common.js";
import {
  listWorkItems,
  listJobs,
} from "../../../queue/functions/index.js";
import {
  stripAnsi,
  fit,
  formatConsoleArg,
  _fmtTokens,
  _fmtUsd,
  _wrapQuestionBodyLines,
  _sanitizeDisplayLine,
  _colorizeAssessorVerdictWords,
  _isNoisyStructuredStderr,
  _isLowSignalStructuredMarker,
} from "../../functions/display/helpers/formatters.js";
import {
  JOB_TYPE_ABBR,
  JOB_TYPE_COLORS_KEY,
  jobLabel,
  jobReportStatus,
  jobDisplayStatus,
  jobIsWriteStep,
  reviewVisibleJobs,
  workItemDisplayStatus,
} from "../../functions/display/helpers/job-status.js";
import {
  PROVIDER_USAGE_REFRESH_MS,
  getProviderUsageSummaryCache,
  _refreshProviderUsageSummaryCacheIfChanged,
  _taskProviderBudgetLines,
  _buildQueueProviderUsageLines,
} from "../../functions/display/helpers/provider-usage.js";
import {
  brandGauge,
  brandRule,
  providerBrandColor,
  roleBrandColor,
} from "../../functions/display/helpers/brand.js";
import { estimateCallCost } from "../../../billing/functions/pricing.js";

export { jobLabel, jobReportStatus, workItemDisplayStatus };

function computeRenderMinGap({ force = false, reason = "general", pendingInput = false } = {}) {
  if (force) return 16;
  if (pendingInput) return 24;
  if (reason === "stream") return 33;
  if (reason === "event") return 40;
  return 48;
}

const WORKER_BOOT_SLOW_MS = 15_000;
const WORKER_BOOT_STALLED_MS = 45_000;

const JOB_FAILURE_STATUSES = new Set(FAILED_JOB_STATUSES);

const REVIEW_HIDDEN_EVENT_ACTORS = new Set(["system", "scheduler", "atlas"]);

function parseEventMeta(event = {}) {
  if (!event?.event_json) return null;
  try {
    return typeof event.event_json === "string" ? JSON.parse(event.event_json) : event.event_json;
  } catch {
    return null;
  }
}

function eventIsReviewVisible(event = {}) {
  const meta = parseEventMeta(event);
  if (meta?.review_visible === true || meta?.reviewVisible === true) return true;
  if (meta?.review_visible === false || meta?.reviewVisible === false || meta?.visible === false) return false;
  const eventType = String(event.event_type || "");
  const actorType = String(event.actor_type || "");
  const message = String(event.message || "");
  if (REVIEW_HIDDEN_EVENT_ACTORS.has(actorType)) return false;
  if (eventType.startsWith("atlas.") || eventType.includes("atlas_")) return false;
  if (/\b(?:index|indexed|indexing|reindex|warm|warming)\b/i.test(`${eventType} ${message}`)) return false;
  return true;
}

function dirtyDiffLabel(entry = {}) {
  if (entry.diff?.summary) return entry.diff.summary;
  if (entry.untracked) return "untracked";
  if (entry.deleted) return "deleted";
  return "changed";
}

function dirtyTreeBlockers(worktreeStatus = {}) {
  const targetFiles = Array.isArray(worktreeStatus?.targetFiles) ? worktreeStatus.targetFiles : [];
  const wtFiles = Array.isArray(worktreeStatus?.wtFiles) ? worktreeStatus.wtFiles : [];
  const blockers = [
    ...targetFiles.map((entry) => ({ ...entry, location: "target" })),
    ...wtFiles.map((entry) => ({ ...entry, location: "worktree" })),
  ];
  if (blockers.length === 0 && worktreeStatus?.targetDirty) {
    blockers.push({ status: "??", path: "(unknown target change)", location: "target" });
  }
  return blockers;
}

function dirtyBlockerTag(entry = {}) {
  if (entry.location === "target") {
    return entry.untracked ? "target untracked" : "target";
  }
  if (entry.inScope) return "worktree in-scope";
  return entry.untracked ? "worktree untracked" : "worktree out-of-scope";
}

function effectiveReviewAssessment(data = {}) {
  const blockers = dirtyTreeBlockers(data.worktreeStatus);
  if (blockers.length > 0) {
    return {
      status: "BLOCKED",
      reason: `${blockers.length} blocking file${blockers.length === 1 ? "" : "s"} require cleanup before approval.`,
      blockers,
    };
  }
  return {
    status: data.finalAssessment?.status || "PASS",
    reason: data.finalAssessment?.reason || "",
    blockers,
  };
}

function resolvedCallCostUsd(call) {
  const est = estimateCallCost({
    provider: call?.provider,
    modelName: call?.model_name,
    modelTier: call?.model_tier,
    inputTokens: call?.input_tokens,
    outputTokens: call?.output_tokens,
    cachedInputTokens: call?.cached_input_tokens,
    knownCostUsd: call?.cost_estimate_usd,
  });
  return Number.isFinite(est.costUsd) ? est.costUsd : 0;
}

// ─── Display ────────────────────────────────────────────────────────────────


export class DisplayApprovalRenderer {
  _renderApproval() {
    if (!this._approvalData || this._approvalData.length === 0) return;

    const fullW = this.cols - 2;
    const contentRows = this.rows - 2;

    const current = typeof this._normalizeApprovalViewState === "function"
      ? this._normalizeApprovalViewState()
      : this._approvalData[this._approvalIdx];
    if (!current) return;
    const TAB_NAMES = ["Tasks", "Tokens", "Research", "Details"];
    const builders = [
      () => this._buildTabTasks(current, fullW),
      () => this._buildTabTokens(current, fullW),
      () => this._buildTabResearch(current, fullW),
      () => this._buildTabDetails(current, fullW),
    ];
    const content = builders[this._approvalTab]();

    // Tab bar
    const tabBar = TAB_NAMES.map((name, i) => {
      const num = `${i + 1}`;
      if (i === this._approvalTab) {
        return `${C.bold}${C.cyan}[${num}:${name}]${C.reset}`;
      }
      return `${C.dim} ${num}:${name} ${C.reset}`;
    }).join(" ");

    // Navigation bar \u2014 in-flight merges override the decision icon with a
    // braille spinner so the user sees their approval is being processed.
    const spinFrames = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
    const spin = spinFrames[this._spinIdx % spinFrames.length];
    const navLines = [];
    const wiIndicators = this._approvalData.map((d, i) => {
      const sel = i === this._approvalIdx;
      const dec = d._decision;
      const icon = d._mergeInFlight ? `${C.yellow}${spin}` :
                   dec === "info" ? `${C.cyan}\u2139` :
                   dec === "approved" ? `${C.green}\u2713` :
                   dec === "rejected" ? `${C.red}\u21bb` :
                   dec === "deleted" ? `${C.red}\u2717` :
                   dec === "skipped" ? `${C.dim}\u00b7` :
                   `${C.yellow}\u25cb`;
      return sel ? `${C.bold}[${icon} ${i + 1}${C.reset}${C.bold}]${C.reset}` : `${icon} ${i + 1}${C.reset}`;
    }).join("  ");
    navLines.push(` ${C.bold}Work Items:${C.reset} ${wiIndicators}`);

    if (this._approvalExitConfirm) {
      const undecided = this._approvalData.filter((d) => !d._decision && !d._isInfo).length;
      navLines.push(` ${C.yellow}${C.bold}Leave review?${C.reset} ${C.yellow}${undecided} undecided item${undecided === 1 ? "" : "s"} will stay pending.${C.reset}  ${C.dim}[Enter/y] Leave  [Esc/n] Keep reviewing${C.reset}`);
    } else if (current._isInfo) {
      navLines.push(` ${C.cyan}[INFO]${C.reset} ${C.dim}Research-only \u2014 no action needed.  [\u2190\u2192] WI  [Tab/1-4] Section  [\u2191\u2193] Scroll  [Enter/Esc] Finish${C.reset}`);
    } else {
      navLines.push(` ${C.green}[a]${C.reset} Approve  ${C.red}[r]${C.reset} Re-queue  ${C.red}[d]${C.reset} Delete  ${C.green}[c]${C.reset} Commit  ${C.yellow}[t]${C.reset} Stash tgt  ${C.red}[x]${C.reset} Discard\u2026  ${C.dim}[s] Skip  [\u2190\u2192] WI  [Tab/1-4] Section  [\u2191\u2193] Scroll  [Enter/Esc] Finish${C.reset}`);
    }

    // Always-visible action feedback: the in-flight/most-recent git action and
    // the auto-advance cue. The Tasks tab embeds the same status in its
    // content, but the user may be on any tab when an action lands.
    const flashFresh = this._approvalFlash
      && (Date.now() - (this._approvalFlash.at || 0)) < 2_500
      ? this._approvalFlash.text
      : null;
    const navActionStatus = current._mergeInFlight
      ? `${C.yellow}${spin} ${current._mergePhase || "Working...."}${C.reset}`
      : (this._approvalTab !== 0 && current._mergeResult ? current._mergeResult : null);
    if (navActionStatus || flashFresh) {
      const bits = [];
      if (flashFresh) bits.push(`${C.cyan}${flashFresh}${C.reset}`);
      if (navActionStatus) bits.push(navActionStatus);
      navLines.push(` ${bits.join(`  ${C.dim}\u00b7${C.reset}  `)}`);
    }

    // -3 for: top border, tab bar, divider above nav; -navLines.length for nav; -1 for bottom border
    const mainRows = Math.max(contentRows - navLines.length - 3, 5);
    const requestedScroll = Number(this._approvalScroll);
    const maxScroll = Math.max(0, content.length - mainRows);
    const scroll = Math.min(
      Number.isFinite(requestedScroll) ? Math.max(0, Math.floor(requestedScroll)) : 0,
      maxScroll,
    );
    this._approvalScroll = scroll;
    if (Array.isArray(this._approvalTabScrolls)) {
      this._approvalTabScrolls[this._approvalTab] = scroll;
    }
    const scrolled = content.slice(scroll);
    const displayContent = [];
    for (let i = 0; i < mainRows; i++) {
      displayContent.push(i < scrolled.length ? scrolled[i] : "");
    }

    // Build frame
    let buf = "";
    let row = 1;

    // Top border with tab bar
    buf += `\x1b[${row};1H${C.dim}\u250c${"\u2500".repeat(fullW)}\u2510${C.reset}\x1b[K`;
    row++;
    buf += `\x1b[${row};1H${C.dim}\u2502${C.reset}${fit(` ${tabBar}`, fullW)}${C.dim}\u2502${C.reset}\x1b[K`;
    row++;
    buf += `\x1b[${row};1H${C.dim}\u251c${"\u2500".repeat(fullW)}\u2524${C.reset}\x1b[K`;
    row++;

    for (let i = 0; i < mainRows; i++) {
      // Choke point: tab content embeds LLM-authored text (titles, research
      // summaries, suggestions, Q&A), so every content line is sanitized here.
      buf += `\x1b[${row};1H${C.dim}\u2502${C.reset}${fit(_sanitizeDisplayLine(displayContent[i]), fullW)}${C.dim}\u2502${C.reset}\x1b[K`;
      row++;
    }

    buf += `\x1b[${row};1H${C.dim}\u251c${"\u2500".repeat(fullW)}\u2524${C.reset}\x1b[K`;
    row++;

    for (const line of navLines) {
      buf += `\x1b[${row};1H${C.dim}\u2502${C.reset}${fit(line, fullW)}${C.dim}\u2502${C.reset}\x1b[K`;
      row++;
    }

    buf += `\x1b[${row};1H${C.dim}\u2514${"\u2500".repeat(fullW)}\u2518${C.reset}\x1b[K`;
    row++;

    buf += `\x1b[${row};1H\x1b[J`;
    if (this._approvalPicker) {
      buf += this._renderDiscardPickerOverlay(this._approvalPicker);
    }
    if (typeof this._baseFrameForBlockingOverlay === "function") {
      buf = this._baseFrameForBlockingOverlay(buf);
    }
    if (typeof this._applyBlockingOverlay === "function") {
      buf = this._applyBlockingOverlay(buf);
    }

    if (buf !== this._lastFrame) {
      const ok = process.stdout.write(buf);
      if (!ok) {
        // Mirror the main render path's backpressure handling: requestRender()
        // skips frames while _stdoutBackedUp is set, and the drained frame is
        // invalidated so the next render repaints in full.
        this._stdoutBackedUp = true;
        process.stdout.once("drain", () => {
          this._stdoutBackedUp = false;
          this._lastFrame = "";
          this.requestRender({ force: true });
        });
      } else {
        this._lastFrame = buf;
      }
    }
  }

  _renderDiscardPickerOverlay(picker) {
    const innerW = Math.min(Math.max(40, this.cols - 12), 96);
    const boxW = innerW + 2;
    const maxList = Math.min(picker.candidates.length, Math.max(6, this.rows - 12));
    const boxH = maxList + 6;
    const startCol = Math.max(2, Math.floor((this.cols - boxW) / 2) + 1);
    const startRow = Math.max(2, Math.floor((this.rows - boxH) / 2) + 1);
    let buf = "";
    let row = startRow;
    const horiz = "─".repeat(innerW);
    buf += `\x1b[${row};${startCol}H${C.dim}┌${horiz}┐${C.reset}`; row++;
    const title = ` ${C.bold}${C.red}Discard blocking files${C.reset}  ${C.dim}— enter discards selected/current, esc cancels${C.reset}`;
    buf += `\x1b[${row};${startCol}H${C.dim}│${C.reset}${fit(title, innerW)}${C.dim}│${C.reset}`; row++;
    buf += `\x1b[${row};${startCol}H${C.dim}├${horiz}┤${C.reset}`; row++;

    const scroll = Math.max(0, picker.cursor - (maxList - 1));
    for (let i = 0; i < maxList; i++) {
      const idx = i + scroll;
      let line = "";
      if (idx < picker.candidates.length) {
        const entry = picker.candidates[idx];
        const marker = picker.selected.has(idx) ? `${C.red}[x]${C.reset}` : `${C.dim}[ ]${C.reset}`;
        const tag = `${C.yellow}${dirtyBlockerTag(entry)}${C.reset}`;
        const focus = idx === picker.cursor ? `${C.cyan}▶${C.reset}` : " ";
        const pathOut = entry.path.slice(0, Math.max(8, innerW - 32));
        line = ` ${focus} ${marker} ${C.dim}${entry.status}${C.reset} ${pathOut} ${C.dim}[${tag}${C.dim}]${C.reset}`;
      }
      buf += `\x1b[${row};${startCol}H${C.dim}│${C.reset}${fit(_sanitizeDisplayLine(line), innerW)}${C.dim}│${C.reset}`;
      row++;
    }

    buf += `\x1b[${row};${startCol}H${C.dim}├${horiz}┤${C.reset}`; row++;
    const discardCount = picker.selected.size > 0 ? picker.selected.size : Math.min(1, picker.candidates.length);
    const footer = ` ${C.dim}[↑↓/j/k] move  [space] toggle  [a] all  [n] none  [enter] discard ${discardCount}/${picker.candidates.length}  [esc] cancel${C.reset}`;
    buf += `\x1b[${row};${startCol}H${C.dim}│${C.reset}${fit(footer, innerW)}${C.dim}│${C.reset}`; row++;
    buf += `\x1b[${row};${startCol}H${C.dim}└${horiz}┘${C.reset}`;
    return buf;
  }

  _wrapText(text, width) {
    const lines = [];
    for (const raw of text.split("\n")) {
      const visible = stripAnsi(raw);
      if (visible.length <= width) {
        lines.push(raw);
      } else {
        // Strip ANSI before wrapping to avoid slicing mid-escape
        for (let i = 0; i < visible.length; i += width) {
          lines.push(visible.slice(i, i + width));
        }
      }
    }
    return lines;
  }

  _buildTabTasks(data, width) {
    const lines = [];
    const inner = width - 2;
    const wi = data.wi;
    const visibleJobs = reviewVisibleJobs(data.jobs);
    const halfW = Math.floor((inner - 3) / 2); // 3 = gap between columns

    // Header
    lines.push("");
    const displayStatus = workItemDisplayStatus(wi, visibleJobs);
    const statusColor = paletteStatusColor(displayStatus, C);
    lines.push(` ${C.bold}WI#${wi.id}:${C.reset} ${wi.title}`);
    lines.push(` ${C.dim}Status:${C.reset} ${statusColor}${displayStatus.toUpperCase()}${C.reset}  ${C.dim}Priority:${C.reset} ${wi.priority}  ${C.dim}Branch:${C.reset} ${wi.branch_name || "(none)"}`);
    if (data.finalAssessment || dirtyTreeBlockers(data.worktreeStatus).length > 0) {
      const assessment = effectiveReviewAssessment(data);
      const color = assessment.status === "PASS" ? C.green : assessment.status === "FAIL" ? C.red : C.yellow;
      lines.push(` ${C.bold}Final Assessment:${C.reset} ${color}${assessment.status}${C.reset} ${C.dim}${String(assessment.reason || "").slice(0, inner - 28)}${C.reset}`);
    }

    const spinFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const spin = spinFrames[this._spinIdx % spinFrames.length];
    const actionStatus = data._mergeInFlight
      ? `${C.yellow}${spin} ${data._mergePhase || "Working...."}${C.reset}`
      : data._mergeResult;

    if (data._decision && data._decision !== "info") {
      const decColor = data._decision === "approved" ? C.green :
                       data._decision === "rejected" ? C.red :
                       data._decision === "deleted" ? C.red : C.dim;
      const decLabel = data._decision === "deleted" ? "DELETED" : data._decision.toUpperCase();
      // Show a live spinner while git work is running, then flip to the
      // _mergeResult string once the queued task completes.
      const mergeStatus = actionStatus ? `  ${actionStatus}` : "";
      lines.push(` ${C.bold}Decision:${C.reset} ${decColor}${decLabel}${C.reset}${mergeStatus}`);
    } else if (actionStatus) {
      lines.push(` ${C.bold}Action:${C.reset} ${actionStatus}`);
    }
    lines.push("");

    // Build left column: Task Completion Report
    const leftLines = [];
    leftLines.push(`${C.bold}Task Completion${C.reset}`);
    leftLines.push(`${C.dim}${"─".repeat(halfW)}${C.reset}`);

    if (visibleJobs.length > 0) {
      const writeJobs = visibleJobs.filter(jobIsWriteStep);
      const researchJobs = visibleJobs.filter((job) => !jobIsWriteStep(job));
      const writeStepById = new Map((data.writeSteps || []).map((step) => [Number(step.id), step]));
      const writeDetailForJob = (job) => writeStepById.get(Number(job.id))?.writes || {};
      const pushJobSummary = (j) => {
        const reportStatus = jobReportStatus(j, visibleJobs);
        const icon = reportStatus === "succeeded" ? `${C.green}\u2713` :
                     reportStatus === "recovered" ? `${C.yellow}\u21bb` :
                     reportStatus === "failed" ? `${C.red}\u2717` :
                     reportStatus === "dead_letter" ? `${C.red}!!` :
                     reportStatus === "canceled" ? `${C.dim}\u00b7` :
                     `${C.dim}~`;
        const recoveredTag = reportStatus === "recovered" ? ` ${C.dim}(recovered)${C.reset}` : "";
        let dur = "";
        if (j.finished_at && j.started_at) {
          const ms = new Date(j.finished_at) - new Date(j.started_at);
          dur = j.job_type === "human_input" ? `${C.dim}wait ${(ms / 1000).toFixed(0)}s${C.reset}` : `${(ms / 1000).toFixed(0)}s`;
        }
        const tierTag = ` [${tierModelName(j.model_tier, { jobType: j.job_type })}]`;
        const label = jobLabel(j.job_type, j.title).slice(0, halfW - 20);
        leftLines.push(`${icon}${C.reset} ${j.job_type}${tierTag}: ${label}${recoveredTag} ${C.dim}${dur}${C.reset}`);

        if (jobIsWriteStep(j)) {
          const writeDetail = writeDetailForJob(j);
          const files = Array.isArray(writeDetail.files) ? writeDetail.files : [];
          if (files.length > 0) {
            const preview = files.slice(0, 2).join(", ");
            const more = files.length > 2 ? ` +${files.length - 2}` : "";
            leftLines.push(`  ${C.dim}wrote ${files.length}: ${preview}${more}${C.reset}`);
          } else if (["succeeded", "recovered"].includes(reportStatus)) {
            leftLines.push(`  ${C.dim}wrote: no committed file changes recorded${C.reset}`);
          }
        }
      };
      const pushJobGroup = (label, jobs, emptyLabel) => {
        leftLines.push(`${C.bold}${label}${C.reset}`);
        if (jobs.length === 0) {
          leftLines.push(`${C.dim}${emptyLabel}${C.reset}`);
          return;
        }
        for (const j of jobs) pushJobSummary(j);
      };
      const jobStates = visibleJobs.map(j => jobReportStatus(j, visibleJobs));
      const succeeded = jobStates.filter(s => s === "succeeded").length;
      const recovered = jobStates.filter(s => s === "recovered").length;
      const failed = jobStates.filter(s => JOB_FAILURE_STATUSES.has(s)).length;
      const other = visibleJobs.length - succeeded - recovered - failed;
      leftLines.push(`${C.green}${succeeded} passed${C.reset}  ${recovered > 0 ? `${C.yellow}${recovered} recovered${C.reset}  ` : ""}${failed > 0 ? `${C.red}${failed} failed${C.reset}  ` : ""}${other > 0 ? `${C.dim}${other} other${C.reset}` : ""}`);
      leftLines.push("");

      pushJobGroup("Write Steps", writeJobs, "No file-tree write jobs");
      if (researchJobs.length > 0) {
        leftLines.push("");
        pushJobGroup("Research / Review Steps", researchJobs, "No research/review jobs");
      }
    } else {
      leftLines.push(`${C.dim}No jobs${C.reset}`);
    }

    // Build right column: File Writes
    const rightLines = [];
    rightLines.push(`${C.bold}File Writes${C.reset}`);
    rightLines.push(`${C.dim}${"─".repeat(halfW)}${C.reset}`);

    if (data.filesActuallyWritten && data.filesActuallyWritten.length > 0) {
      rightLines.push(`${C.green}Actual writes${C.reset}`);
      for (const f of data.filesActuallyWritten) {
        rightLines.push(`${C.dim}\u2022${C.reset} ${f.slice(0, halfW - 2)}`);
      }
    } else if (data.gitDiff && data.gitDiff.length > 0) {
      for (const line of data.gitDiff) {
        rightLines.push(line.slice(0, halfW));
      }
    } else if (data.plannedWriteFiles && data.plannedWriteFiles.length > 0) {
      rightLines.push(`${C.dim}Planned write scope${C.reset}`);
      for (const f of data.plannedWriteFiles) {
        rightLines.push(`${C.dim}\u2022${C.reset} ${f.slice(0, halfW - 2)}`);
      }
    } else if (data.filesToModify && data.filesToModify.length > 0) {
      rightLines.push(`${C.dim}Declared file scope${C.reset}`);
      for (const f of data.filesToModify) {
        rightLines.push(`${C.dim}\u2022${C.reset} ${f.slice(0, halfW - 2)}`);
      }
    } else if (data._isInfo) {
      rightLines.push(`${C.dim}(research only)${C.reset}`);
    } else if (wi.branch_name) {
      rightLines.push(`${C.dim}(no changes detected)${C.reset}`);
    } else {
      rightLines.push(`${C.dim}(no branch created)${C.reset}`);
    }

    // Merge columns side by side
    const maxRows = Math.max(leftLines.length, rightLines.length);
    for (let i = 0; i < maxRows; i++) {
      const left = i < leftLines.length ? leftLines[i] : "";
      const right = i < rightLines.length ? rightLines[i] : "";
      lines.push(` ${fit(left, halfW)}${C.dim} \u2502 ${C.reset}${fit(right, halfW)}`);
    }

    lines.push("");

    // Worktree Status \u2014 surfaces merge blockers before the user approves.
    const ws = data.worktreeStatus;
    if (ws) {
      const targetCount = (ws.targetFiles || []).length;
      const wtCount = (ws.wtFiles || []).length;
      const outOfScope = (ws.wtFiles || []).filter((f) => !f.inScope).length;
      const stashes = ws.wtStashes || 0;

      const targetName = ws.targetBranch || "target";
      const targetDir = ws.targetDir || "";
      const sourceBranch = ws.sourceBranch || wi.branch_name || null;
      const sourceDir = ws.sourceDir || ws.wtDir || "";
      const targetSuffix = targetDir ? ` ${C.dim}@ ${targetDir}${C.reset}` : "";
      const sourceSuffix = sourceBranch
        ? ` ${C.dim}${sourceBranch}${sourceDir ? ` @ ${sourceDir}` : ""}${C.reset}`
        : ` ${C.dim}no WI branch${sourceDir ? ` @ ${sourceDir}` : ""}${C.reset}`;

      const targetLabel = targetCount > 0
        ? `${C.red}${C.bold}\u26a0 ${targetName} dirty (${targetCount})${C.reset} ${C.dim}\u2014 blocks merge${C.reset}`
        : `${C.green}\u2713 ${targetName} clean${C.reset}`;

      let wtLabel;
      if (!ws.wtDir) {
        wtLabel = `${C.dim}no worktree${C.reset}`;
      } else if (!ws.wtExists) {
        wtLabel = `${C.dim}worktree missing${C.reset}`;
      } else if (wtCount === 0) {
        wtLabel = `${C.green}\u2713 worktree clean${C.reset}${stashes > 0 ? `  ${C.yellow}${stashes} stash(es)${C.reset}` : ""}`;
      } else {
        const oosTag = outOfScope > 0 ? `  ${C.yellow}${outOfScope} out-of-scope${C.reset}` : "";
        const stashTag = stashes > 0 ? `  ${C.yellow}${stashes} stash(es)${C.reset}` : "";
        wtLabel = `${C.yellow}\u26a0 worktree dirty (${wtCount})${C.reset}${oosTag}${stashTag}`;
      }

      lines.push(` ${C.bold}Worktree:${C.reset} ${wtLabel}${sourceSuffix}`);
      lines.push(` ${C.bold}Target:${C.reset}   ${targetLabel}${targetSuffix}`);

      const pushBlockingFiles = (entries, limit) => {
        const preview = entries.slice(0, limit);
        if (preview.length === 0) return;
        lines.push(`   ${C.bold}Blocking files (${entries.length}):${C.reset}`);
        for (const entry of preview) {
          const tag = dirtyBlockerTag(entry);
          const diff = dirtyDiffLabel(entry);
          const maxPath = Math.max(12, inner - 48);
          lines.push(`     ${C.dim}${entry.status}${C.reset} ${entry.path.slice(0, maxPath)} ${C.dim}${diff}${C.reset} ${C.dim}[${tag}${C.dim}]${C.reset}`);
        }
        if (entries.length > preview.length) {
          lines.push(`     ${C.dim}\u2026 ${entries.length - preview.length} more (see Details tab)${C.reset}`);
        }
      };

      pushBlockingFiles(dirtyTreeBlockers(ws), 8);
      if (targetCount > 0 && targetDir) {
        lines.push(`   ${C.dim}diff target: git -C "${targetDir}" diff HEAD -- <file>${C.reset}`);
      }
      if (wtCount > 0 && ws.wtDir) {
        lines.push(`   ${C.dim}diff worktree: git -C "${ws.wtDir}" diff HEAD -- <file>${C.reset}`);
      }

      const hints = [];
      if (wtCount > 0) hints.push(`${C.green}[c]${C.reset} commit in-scope`);
      if (outOfScope > 0 || (ws.wtFiles || []).some((f) => f.untracked)) hints.push(`${C.red}[x]${C.reset} discard files`);
      if (targetCount > 0) hints.push(`${C.yellow}[t]${C.reset} stash target`);
      if (hints.length > 0) {
        lines.push(` ${C.dim}${hints.join("  ")}${C.reset}`);
      }
      lines.push("");
    }

    if (Array.isArray(data.memoriesSurfaced) && data.memoriesSurfaced.length > 0) {
      const previewMemories = data.memoriesSurfaced.slice(0, 4);
      lines.push(` ${C.bold}Memories Surfaced:${C.reset} ${previewMemories.length}${data.memoriesSurfaced.length > previewMemories.length ? ` ${C.dim}(+${data.memoriesSurfaced.length - previewMemories.length} more in Details)${C.reset}` : ""}`);
      for (const memory of previewMemories) {
        const kind = memory.kind || memory.type || "memory";
        const id = memory.memoryId || memory.id || "?";
        lines.push(`   ${C.dim}[${kind}]${C.reset} ${String(memory.summary || memory.action || id).slice(0, inner - 14)}`);
      }
      lines.push(`   ${C.dim}Review memories: note | suppress | correct${C.reset}`);
      lines.push("");
    } else {
      lines.push(` ${C.bold}Memories Surfaced:${C.reset} ${C.dim}none${C.reset}`);
      lines.push("");
    }

    // Key stats bar
    lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 80))}${C.reset}`);
    const totalDur = ((data.totalDuration || 0) / 1000).toFixed(1);
    const totalIn = data.totalInputTokens ? _fmtTokens(data.totalInputTokens) : "0";
    const totalOut = data.totalOutputTokens ? _fmtTokens(data.totalOutputTokens) : "0";
    const totalTools = Number(data.totalToolCalls || 0);
    const totalCostUsd = Number(data.totalCostUsd ?? (data.agentCalls || []).reduce((sum, call) => sum + resolvedCallCostUsd(call), 0)) || 0;
    const jobCount = visibleJobs.length;
    const passCount = visibleJobs.filter(j => ["succeeded", "recovered"].includes(jobReportStatus(j, visibleJobs))).length;
    lines.push(` ${C.bold}Duration:${C.reset} ${totalDur}s  ${C.bold}Jobs:${C.reset} ${passCount}/${jobCount} passed  ${C.bold}Tokens:${C.reset} ${totalIn} in / ${totalOut} out  ${C.bold}Calls:${C.reset} ${(data.agentCalls || []).length}  ${C.bold}Tools:${C.reset} ${totalTools}  ${C.bold}Cost:${C.reset} ${_fmtUsd(totalCostUsd)}`);
    for (const line of _taskProviderBudgetLines(data, getProviderUsageSummaryCache().summaries || [])) {
      lines.push(line);
    }
    lines.push("");

    return lines;
  }

  _buildTabTokens(data, width) {
    const lines = [];
    const inner = width - 2;
    const wi = data.wi;

    lines.push("");
    const _ruleWidth = Math.max(40, Math.min(inner, 76));
    const _wiTail = ` ${C.dim}WI#${wi.id} \u00b7 ${wi.title.slice(0, 50)}${C.reset}`;
    lines.push(`${brandRule({ label: "token usage", color: C.cyan, width: _ruleWidth })}${_wiTail}`);
    lines.push("");

    // ── Prominent summary box ──
    const totalIn = data.totalInputTokens || 0;
    const totalOut = data.totalOutputTokens || 0;
    const totalTok = totalIn + totalOut;
    const totalDur = ((data.totalDuration || 0) / 1000);
    const callCount = (data.agentCalls || []).length;
    const succeededCalls = (data.agentCalls || []).filter(c => c.status === "succeeded").length;
    const failedCalls = (data.agentCalls || []).filter(c => c.status === "failed").length;
    const timeoutCalls = (data.agentCalls || []).filter(c => c.status === "timeout").length;
    const totalToolCalls = Number(
      data.totalToolCalls
      ?? data.totals?.toolCalls
      ?? (Array.isArray(data.toolUsageSummary) ? data.toolUsageSummary.reduce((sum, item) => sum + (Number(item?.count) || 0), 0) : 0)
    ) || 0;
    const totalCostUsd = Number(
      data.totalCostUsd
      ?? data.totals?.costUsd
      ?? (data.agentCalls || []).reduce((sum, call) => sum + resolvedCallCostUsd(call), 0)
    ) || 0;

    const dot = `  ${C.dim}·${C.reset}  `;
    const kv = (label, valueText) => `   ${C.dim}${label.padEnd(10)}${C.reset} ${C.bold}${valueText}${C.reset}`;
    lines.push(`${kv("tokens", `${C.cyan}${_fmtTokens(totalTok)}${C.reset}`)}${dot}${C.dim}${_fmtTokens(totalIn)} in${C.reset} ${C.dim}+ ${_fmtTokens(totalOut)} out${C.reset}`);
    lines.push(`${kv("duration", `${totalDur.toFixed(1)}s`)}${dot}${C.dim}${(totalDur / 60).toFixed(1)} min${C.reset}`);
    const _callsValue =
      `${callCount} ${C.dim}(${C.reset}${C.green}${succeededCalls} ok${C.reset}` +
      (failedCalls > 0 ? `${C.dim}, ${C.reset}${C.red}${failedCalls} fail${C.reset}` : "") +
      (timeoutCalls > 0 ? `${C.dim}, ${C.reset}${C.yellow}${timeoutCalls} timeout${C.reset}` : "") +
      `${C.dim})${C.reset}`;
    lines.push(`${kv("calls", _callsValue)}`);
    lines.push(`${kv("tools", String(totalToolCalls))}${dot}${C.dim}cost${C.reset} ${C.bold}${_fmtUsd(totalCostUsd)}${C.reset}`);
    lines.push("");

    // ── Model usage breakdown ──
    const budgetLines = _taskProviderBudgetLines(data, getProviderUsageSummaryCache().summaries || []);
    for (const line of budgetLines) {
      lines.push(line);
    }
    if (budgetLines.length > 0) {
      lines.push("");
    }
    lines.push(brandRule({ label: "models", color: C.cyan, width: _ruleWidth }));
    const modelMap = new Map();
    for (const call of (data.agentCalls || [])) {
      const key = call.model_name || tierModelName(call.model_tier, { providerName: call.provider }) || "unknown";
      if (!modelMap.has(key)) {
        modelMap.set(key, { calls: 0, inputTokens: 0, outputTokens: 0, duration: 0, costUsd: 0, succeeded: 0, failed: 0 });
      }
      const m = modelMap.get(key);
      m.calls++;
      m.inputTokens += (call.input_tokens || 0);
      m.outputTokens += (call.output_tokens || 0);
      m.duration += (call.duration_ms || 0);
      m.costUsd += resolvedCallCostUsd(call);
      if (call.status === "succeeded") m.succeeded++;
      else m.failed++;
    }

    if (modelMap.size > 0) {
      const hdr = `  ${"Model".padEnd(18)} ${"Calls".padStart(6)} ${"In Tok".padStart(9)} ${"Out Tok".padStart(9)} ${"Cost".padStart(9)} ${"Duration".padStart(9)} ${"Success".padStart(8)}`;
      lines.push(` ${C.dim}${hdr}${C.reset}`);
      lines.push(` ${C.dim}${"─".repeat(Math.min(hdr.length + 2, inner))}${C.reset}`);

      for (const [model, m] of modelMap) {
        const rate = m.calls > 0 ? `${Math.round(100 * m.succeeded / m.calls)}%` : "—";
        const rateColor = m.failed === 0 ? C.green : C.yellow;
        lines.push(
          `  ${C.bold}${model.padEnd(18)}${C.reset} ` +
          `${String(m.calls).padStart(6)} ` +
          `${_fmtTokens(m.inputTokens).padStart(9)} ` +
          `${_fmtTokens(m.outputTokens).padStart(9)} ` +
          `${_fmtUsd(m.costUsd).padStart(9)} ` +
          `${(m.duration / 1000).toFixed(1).padStart(8)}s ` +
          `${rateColor}${rate.padStart(8)}${C.reset}`
        );
      }
      lines.push("");
    }

    // ── Per-role breakdown ──
    lines.push(brandRule({ label: "roles", color: C.cyan, width: _ruleWidth }));
    const roleMap = new Map();
    for (const call of (data.agentCalls || [])) {
      const key = call.role || "unknown";
      if (!roleMap.has(key)) {
        roleMap.set(key, { calls: 0, inputTokens: 0, outputTokens: 0, duration: 0, costUsd: 0 });
      }
      const r = roleMap.get(key);
      r.calls++;
      r.inputTokens += (call.input_tokens || 0);
      r.outputTokens += (call.output_tokens || 0);
      r.duration += (call.duration_ms || 0);
      r.costUsd += resolvedCallCostUsd(call);
    }

    if (roleMap.size > 0) {
      const hdr2 = `  ${"Role".padEnd(14)} ${"Calls".padStart(6)} ${"In Tok".padStart(9)} ${"Out Tok".padStart(9)} ${"Cost".padStart(9)} ${"Duration".padStart(9)} ${"% Tokens".padStart(9)}`;
      lines.push(` ${C.dim}${hdr2}${C.reset}`);
      lines.push(` ${C.dim}${"─".repeat(Math.min(hdr2.length + 2, inner))}${C.reset}`);

      for (const [role, r] of roleMap) {
        const color = roleBrandColor(role);
        const pct = totalTok > 0 ? `${Math.round(100 * (r.inputTokens + r.outputTokens) / totalTok)}%` : "—";
        lines.push(
          `  ${color}${role.padEnd(14)}${C.reset} ` +
          `${String(r.calls).padStart(6)} ` +
          `${_fmtTokens(r.inputTokens).padStart(9)} ` +
          `${_fmtTokens(r.outputTokens).padStart(9)} ` +
          `${_fmtUsd(r.costUsd).padStart(9)} ` +
          `${(r.duration / 1000).toFixed(1).padStart(8)}s ` +
          `${pct.padStart(9)}`
        );
      }
      lines.push("");
    }

    lines.push(brandRule({ label: "tools", color: C.cyan, width: _ruleWidth }));
    const toolSummary = Array.isArray(data.toolUsageSummary)
      ? data.toolUsageSummary
        .map((item) => ({ type: String(item?.type || "unknown"), count: Number(item?.count) || 0 }))
        .filter((item) => item.count > 0)
      : [];
    if (toolSummary.length > 0) {
      const hdrTools = `  ${"Tool".padEnd(18)} ${"Calls".padStart(8)} ${"Share".padStart(8)}`;
      lines.push(` ${C.dim}${hdrTools}${C.reset}`);
      lines.push(` ${C.dim}${"─".repeat(Math.min(hdrTools.length + 2, inner))}${C.reset}`);
      for (const item of toolSummary) {
        const share = totalToolCalls > 0 ? `${Math.round((100 * item.count) / totalToolCalls)}%` : "—";
        lines.push(`  ${item.type.slice(0, 18).padEnd(18)} ${String(item.count).padStart(8)} ${share.padStart(8)}`);
      }
    } else {
      lines.push(`  ${C.dim}No tool calls recorded${C.reset}`);
    }
    lines.push("");

    // ── Individual calls table ──
    lines.push(brandRule({ label: "agent calls", color: C.cyan, width: _ruleWidth }));
    if (data.agentCalls && data.agentCalls.length > 0) {
      const hdr3 = `  ${"Role".padEnd(12)} ${"Model".padEnd(14)} ${"Eff".padEnd(4)} ${"Duration".padStart(9)} ${"In Tok".padStart(8)} ${"Out Tok".padStart(9)} ${"Cost".padStart(9)} ${"Status".padEnd(10)}`;
      lines.push(` ${C.dim}${hdr3}${C.reset}`);
      lines.push(` ${C.dim}${"─".repeat(Math.min(hdr3.length + 2, inner))}${C.reset}`);

      for (const call of data.agentCalls) {
        const color = roleBrandColor(call.role);
        const dur = call.duration_ms ? `${(call.duration_ms / 1000).toFixed(1)}s` : "\u2014";
        const inTok = call.input_tokens ? _fmtTokens(call.input_tokens) : "\u2014";
        const outTok = call.output_tokens ? _fmtTokens(call.output_tokens) : "\u2014";
        const cost = _fmtUsd(resolvedCallCostUsd(call));
        const model = (call.model_name || tierModelName(call.model_tier, { providerName: call.provider }) || "?").slice(0, 13);
        const effort = call.reasoning_effort ? call.reasoning_effort.slice(0, 3) : "med";
        const thinkTag = call.extended_thinking ? `${C.magenta}\u2605${C.reset}` : " ";
        const statusIcon = call.status === "succeeded" ? `${C.green}\u2713 ok${C.reset}` :
                          call.status === "failed" ? `${C.red}\u2717 fail${C.reset}` :
                          call.status === "timeout" ? `${C.yellow}\u23f1 timeout${C.reset}` :
                          `${C.yellow}${call.status}${C.reset}`;

        lines.push(
          `  ${color}${(call.role || "?").padEnd(12)}${C.reset} ` +
          `${model.padEnd(14)} ` +
          `${effort.padEnd(3)}${thinkTag}` +
          `${dur.padStart(9)} ` +
          `${inTok.padStart(8)} ` +
          `${outTok.padStart(9)} ` +
          `${cost.padStart(9)} ` +
          `${statusIcon}`
        );
      }
    } else {
      lines.push(`  ${C.dim}No agent calls recorded${C.reset}`);
    }

    lines.push("");
    return lines;
  }

  _buildTabResearch(data, width) {
    const lines = [];
    const inner = width - 2;
    const wi = data.wi;

    lines.push("");
    lines.push(` ${C.bold}${C.cyan}\u2550\u2550\u2550 RESEARCH SUMMARY \u2550\u2550\u2550${C.reset}  ${C.dim}WI#${wi.id}: ${wi.title.slice(0, 50)}${C.reset}`);
    lines.push("");

    const summary = data.researchSummary || "";
    if (summary.length > 0) {
      const wrapped = this._wrapText(summary, inner - 2);
      for (const line of wrapped) {
        lines.push(`  ${line}`);
      }
    } else {
      lines.push(`  ${C.dim}No research summary available for this work item.${C.reset}`);
      lines.push("");
      lines.push(`  ${C.dim}This can happen if:${C.reset}`);
      lines.push(`  ${C.dim}\u2022 The researcher phase was skipped${C.reset}`);
      lines.push(`  ${C.dim}\u2022 The work item went directly to planning${C.reset}`);
      lines.push(`  ${C.dim}\u2022 The researcher output was not stored as an artifact${C.reset}`);
    }

    lines.push("");
    return lines;
  }

  _buildTabDetails(data, width) {
    const lines = [];
    const inner = width - 2;
    const wi = data.wi;
    const visibleJobs = reviewVisibleJobs(data.jobs);

    lines.push("");
    lines.push(` ${C.bold}${C.cyan}\u2550\u2550\u2550 DETAILS \u2550\u2550\u2550${C.reset}  ${C.dim}WI#${wi.id}: ${wi.title.slice(0, 50)}${C.reset}`);
    lines.push("");

    // ── Work Item Info ──
    lines.push(` ${C.bold}Work Item${C.reset}`);
    lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 60))}${C.reset}`);
    const displayStatus = workItemDisplayStatus(wi, visibleJobs);
    const statusColor = paletteStatusColor(displayStatus, C);
    lines.push(`  ${C.dim}ID:${C.reset}       ${wi.id}`);
    lines.push(`  ${C.dim}Status:${C.reset}   ${statusColor}${displayStatus.toUpperCase()}${C.reset}`);
    lines.push(`  ${C.dim}Priority:${C.reset} ${wi.priority}`);
    lines.push(`  ${C.dim}Branch:${C.reset}   ${wi.branch_name || "(none)"}`);
    if (wi.merge_state) {
      const msColor = wi.merge_state === "merged" ? C.green : wi.merge_state === "merge_failed" ? C.red : C.yellow;
      lines.push(`  ${C.dim}Merge:${C.reset}    ${msColor}${wi.merge_state}${C.reset}`);
    }
    if (wi.created_at) lines.push(`  ${C.dim}Created:${C.reset}  ${wi.created_at}`);
    if (wi.completed_at) lines.push(`  ${C.dim}Finished:${C.reset} ${wi.completed_at}`);
    lines.push("");

    // ── Worktree Status (full listing) ──
    const ws = data.worktreeStatus;
    if (ws) {
      lines.push(` ${C.bold}Worktree Status${C.reset}`);
      lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 60))}${C.reset}`);

      const targetDir = ws.targetDir || "";
      const sourceBranch = ws.sourceBranch || wi.branch_name || null;
      const sourceDir = ws.sourceDir || ws.wtDir || "";
      lines.push(`  ${C.dim}Target:${C.reset}   ${ws.targetBranch || "(unknown)"}${targetDir ? ` ${C.dim}@ ${targetDir}${C.reset}` : ""}`);
      lines.push(`  ${C.dim}Source:${C.reset}   ${sourceBranch || "(no WI branch)"}`);
      lines.push(`  ${C.dim}Worktree:${C.reset} ${sourceDir || "(none)"}`);
      const scopeFiles = [...(ws.scope?.files || []), ...(ws.scope?.roots || []).map((root) => `${root}/`)];
      if (scopeFiles.length > 0) {
        lines.push(`  ${C.dim}Plan scope:${C.reset} ${scopeFiles.slice(0, 8).join(", ")}${scopeFiles.length > 8 ? ` ${C.dim}(+${scopeFiles.length - 8} more)${C.reset}` : ""}`);
      }
      lines.push("");

      if (ws.targetDirty) {
        lines.push(`  ${C.red}${C.bold}⚠ Target branch ${ws.targetBranch || ""} has ${ws.targetFiles.length} uncommitted change(s) — blocks every merge${C.reset}`);
        for (const entry of ws.targetFiles.slice(0, 12)) {
          lines.push(`    ${C.dim}${entry.status}${C.reset} ${entry.path} ${C.dim}${dirtyDiffLabel(entry)}${C.reset}`);
        }
        if (ws.targetFiles.length > 12) {
          lines.push(`    ${C.dim}… ${ws.targetFiles.length - 12} more${C.reset}`);
        }
        if (targetDir) lines.push(`  ${C.dim}Diff: git -C "${targetDir}" diff HEAD -- <file>${C.reset}`);
        lines.push(`  ${C.dim}Press [t] to stash target-branch changes before approving.${C.reset}`);
        lines.push("");
      } else {
        lines.push(`  ${C.green}✓ Target branch ${ws.targetBranch || ""} clean${C.reset}`);
        lines.push("");
      }

      if (!ws.wtDir) {
        lines.push(`  ${C.dim}No worktree for this WI (research-only)${C.reset}`);
      } else if (!ws.wtExists) {
        lines.push(`  ${C.dim}Worktree directory missing or already cleaned up (${ws.wtDir})${C.reset}`);
      } else if (ws.wtFiles.length === 0) {
        lines.push(`  ${C.green}✓ WI worktree clean${C.reset} ${C.dim}(${ws.wtDir})${C.reset}`);
        if (ws.wtStashes > 0) lines.push(`  ${C.yellow}${ws.wtStashes} stash(es) present — review with 'git stash list' in the worktree${C.reset}`);
      } else {
        const inScope = ws.wtFiles.filter((f) => f.inScope);
        const untracked = ws.wtFiles.filter((f) => !f.inScope && f.untracked);
        const outOfScope = ws.wtFiles.filter((f) => !f.inScope && !f.untracked);
        lines.push(`  ${C.yellow}⚠ WI worktree has ${ws.wtFiles.length} dirty file(s)${C.reset} ${C.dim}(${ws.wtDir})${C.reset}`);
        lines.push(`  ${C.dim}Squash merge only includes committed work — anything left here is dropped on cleanup.${C.reset}`);
        lines.push("");

        if (inScope.length > 0) {
          lines.push(`  ${C.green}In-scope (${inScope.length})${C.reset} ${C.dim}— press [c] to commit to WI branch${C.reset}`);
          for (const entry of inScope.slice(0, 12)) {
            lines.push(`    ${C.dim}${entry.status}${C.reset} ${entry.path} ${C.dim}${dirtyDiffLabel(entry)}${C.reset}`);
          }
          if (inScope.length > 12) lines.push(`    ${C.dim}… ${inScope.length - 12} more${C.reset}`);
          lines.push(`  ${C.dim}Diff: git -C "${ws.wtDir}" diff HEAD -- <file>${C.reset}`);
          lines.push("");
        }
        if (outOfScope.length > 0) {
          lines.push(`  ${C.yellow}Out-of-scope tracked (${outOfScope.length})${C.reset} ${C.dim}— press [x] to discard${C.reset}`);
          for (const entry of outOfScope.slice(0, 12)) {
            lines.push(`    ${C.dim}${entry.status}${C.reset} ${entry.path} ${C.dim}${dirtyDiffLabel(entry)}${C.reset}`);
          }
          if (outOfScope.length > 12) lines.push(`    ${C.dim}… ${outOfScope.length - 12} more${C.reset}`);
          lines.push(`  ${C.dim}Diff: git -C "${ws.wtDir}" diff HEAD -- <file>${C.reset}`);
          lines.push("");
        }
        if (untracked.length > 0) {
          lines.push(`  ${C.yellow}Untracked (${untracked.length})${C.reset} ${C.dim}— press [x] to discard${C.reset}`);
          for (const entry of untracked.slice(0, 12)) {
            lines.push(`    ${C.dim}${entry.status}${C.reset} ${entry.path}`);
          }
          if (untracked.length > 12) lines.push(`    ${C.dim}… ${untracked.length - 12} more${C.reset}`);
          lines.push("");
        }
        if (ws.wtStashes > 0) {
          lines.push(`  ${C.yellow}${ws.wtStashes} stash(es) present in worktree${C.reset}`);
          lines.push("");
        }
      }
      lines.push("");
    }

    // ── Final Assessment ──
    if (data.finalAssessment || dirtyTreeBlockers(data.worktreeStatus).length > 0) {
      const assessment = effectiveReviewAssessment(data);
      const color = assessment.status === "PASS" ? C.green : assessment.status === "FAIL" ? C.red : C.yellow;
      lines.push(` ${C.bold}Final Assessment${C.reset}`);
      lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 60))}${C.reset}`);
      lines.push(`  ${C.dim}Status:${C.reset} ${color}${assessment.status}${C.reset}`);
      lines.push(`  ${C.dim}Reason:${C.reset} ${assessment.reason || ""}`);
      if (assessment.status === "BLOCKED") {
        lines.push(`  ${C.yellow}This WI should not be approved until the blocker is resolved.${C.reset}`);
      }
      lines.push("");
    }

    // ── Memory Review ──
    const surfaced = Array.isArray(data.memoriesSurfaced) ? data.memoriesSurfaced : [];
    lines.push(` ${C.bold}Review Memories${C.reset}`);
    lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 60))}${C.reset}`);
    if (surfaced.length === 0) {
      lines.push(`  ${C.dim}No durable memories or kaizen insights were surfaced for this WI.${C.reset}`);
    } else {
      for (const memory of surfaced.slice(0, 12)) {
        const id = memory.memoryId || memory.id || "(local)";
        const kind = memory.kind || memory.type || "memory";
        const stale = memory.stale ? ` ${C.yellow}(stale)${C.reset}` : "";
        lines.push(`  ${C.cyan}${kind}${C.reset} ${C.dim}${id}${C.reset}${stale}`);
        lines.push(`    ${String(memory.summary || memory.action || "").slice(0, inner - 6)}`);
        if (memory.whySurfaced) lines.push(`    ${C.dim}why: ${String(memory.whySurfaced).slice(0, inner - 10)}${C.reset}`);
        lines.push(`    ${C.dim}actions: note | suppress | correct${C.reset}`);
      }
      if (surfaced.length > 12) lines.push(`  ${C.dim}… ${surfaced.length - 12} more surfaced memories${C.reset}`);
    }
    const proposed = Array.isArray(data.memoriesProposed) ? data.memoriesProposed : [];
    if (proposed.length > 0) {
      lines.push("");
      lines.push(` ${C.bold}Memories Proposed${C.reset}`);
      for (const memory of proposed.slice(0, 12)) {
        const status = memory.promotionStatus || "pending";
        const color = status === "promoted" ? C.green : status === "rejected" || status === "failed" ? C.red : C.yellow;
        lines.push(`  ${color}${status}${C.reset} ${C.dim}${memory.type || memory.source || "kaizen"}${C.reset}: ${String(memory.summary || "").slice(0, inner - 18)}`);
        if (memory.rejectionReason) lines.push(`    ${C.dim}reason: ${memory.rejectionReason}${C.reset}`);
      }
    }
    lines.push("");

    // ── Assessor Suggestions ──
    const suggestions = [];
    if (data.reviewArtifacts) {
      for (const art of data.reviewArtifacts) {
        try {
          const parsed = JSON.parse(art.content_json);
          if (parsed && parsed.type === "suggestions" && Array.isArray(parsed.suggestions)) {
            suggestions.push(...parsed.suggestions);
          }
        } catch { /* skip */ }
      }
    }
    if (suggestions.length > 0) {
      lines.push(` ${C.cyan}${C.bold}Assessor Suggestions${C.reset} ${C.dim}(improvement ideas from code review)${C.reset}`);
      lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 60))}${C.reset}`);
      for (const s of suggestions) {
        const wrapped = this._wrapText(s, inner - 4);
        lines.push(`  ${C.cyan}\u2022${C.reset} ${wrapped[0]}`);
        for (let i = 1; i < wrapped.length; i++) {
          lines.push(`    ${wrapped[i]}`);
        }
      }
      lines.push("");
    }

    // ── Human Q&A ──
    if (data.humanAnswers && data.humanAnswers.length > 0) {
      lines.push(` ${C.bold}Human Q&A${C.reset}`);
      lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 60))}${C.reset}`);
      for (const art of data.humanAnswers) {
        try {
          const pairs = JSON.parse(art.content_json);
          for (const pair of pairs) {
            lines.push(`  ${C.yellow}Q:${C.reset} ${pair.question}`);
            lines.push(`  ${C.green}A:${C.reset} ${pair.answer}`);
            lines.push("");
          }
        } catch { /* skip malformed */ }
      }
    }

    // ── Event Timeline ──
    const visibleEvents = (data.events || []).filter(eventIsReviewVisible);
    if (visibleEvents.length > 0) {
      lines.push(` ${C.bold}Event Timeline${C.reset}`);
      lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 60))}${C.reset}`);

      for (const ev of visibleEvents) {
        const time = ev.created_at ? ev.created_at.replace("T", " ").slice(0, 19) : "?";
        const typeColor =
          ev.event_type?.includes("file_request_auto") ? C.green :
          ev.event_type?.includes("file_request_gated") || ev.event_type?.includes("file_request_pending") ? C.yellow :
          ev.event_type?.includes("file_request") ? C.cyan :
          ev.event_type?.includes("approved") || ev.event_type?.includes("merged") ? C.green :
          ev.event_type?.includes("failed") || ev.event_type?.includes("rejected") ? C.red :
          ev.event_type?.includes("started") || ev.event_type?.includes("created") ? C.cyan :
          C.dim;
        const eventType = (ev.event_type || "").replace("work_item.", "").replace("git.", "");
        const msg = (ev.message || "").slice(0, inner - 35);
        lines.push(`  ${C.dim}${time}${C.reset}  ${typeColor}${eventType.padEnd(18)}${C.reset} ${msg}`);
      }
      lines.push("");
    }

    // ── Job Attempt Details ──
    if (visibleJobs.length > 0) {
      lines.push(` ${C.bold}Job Details${C.reset}`);
      lines.push(` ${C.dim}${"─".repeat(Math.min(inner, 60))}${C.reset}`);
      for (const j of visibleJobs) {
        const displayStatus = jobDisplayStatus(j, visibleJobs);
        const icon = displayStatus === "succeeded" ? `${C.green}\u2713` :
                     displayStatus === "recovered" ? `${C.yellow}\u21bb` :
                     displayStatus === "failed" ? `${C.red}\u2717` :
                     displayStatus === "dead_letter" ? `${C.red}!!` :
                     j.status === "canceled" ? `${C.dim}\u00b7` : `${C.dim}~`;
        lines.push(`  ${icon}${C.reset} ${C.bold}#${j.id} ${j.job_type}${C.reset}: ${jobLabel(j.job_type, j.title).slice(0, inner - 30)}`);
        const recoveredTag = displayStatus === "recovered" ? " (recovered)" : "";
        lines.push(`    ${C.dim}Status: ${j.status}${recoveredTag}  Attempts: ${j.attempt_count || 0}/${j.max_attempts || 3}  Model: ${tierModelName(j.model_tier, { jobType: j.job_type })}${C.reset}`);
        if (j.assessor_verdict && j.assessor_verdict !== "not_assessed") {
          const vColor = j.assessor_verdict === "pass" ? C.green : j.assessor_verdict === "fail" ? C.red : C.yellow;
          lines.push(`    ${C.dim}Verdict:${C.reset} ${vColor}${j.assessor_verdict}${C.reset}`);
        }
        if (j.started_at && j.finished_at) {
          const ms = new Date(j.finished_at) - new Date(j.started_at);
          lines.push(`    ${C.dim}Duration: ${(ms / 1000).toFixed(1)}s  Started: ${j.started_at.replace("T", " ").slice(0, 19)}${C.reset}`);
        }
        lines.push("");
      }
    }

    return lines;
  }

}
