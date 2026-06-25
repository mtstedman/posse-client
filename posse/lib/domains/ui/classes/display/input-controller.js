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
import { C } from "../../../../shared/format/functions/colors.js";
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
  jobIsDisplayFailure,
  jobIsDisplaySuccess,
  workItemDisplayStatus,
} from "../../functions/display/helpers/job-status.js";
import {
  PROVIDER_USAGE_REFRESH_MS,
  getProviderUsageSummaryCache,
  _refreshProviderUsageSummaryCacheIfChanged,
  _taskProviderBudgetLines,
  _buildQueueProviderUsageLines,
} from "../../functions/display/helpers/provider-usage.js";
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

function resolvedCallCostUsd(call) {
  const est = estimateCallCost({
    provider: call?.provider,
    modelName: call?.model_name,
    modelTier: call?.model_tier,
    inputTokens: call?.input_tokens,
    outputTokens: call?.output_tokens,
    cachedInputTokens: call?.cached_input_tokens,
    cacheCreationInputTokens: call?.cache_creation_input_tokens,
    knownCostUsd: call?.cost_estimate_usd,
  });
  return Number.isFinite(est.costUsd) ? est.costUsd : 0;
}

function reviewDiscardCandidates(worktreeStatus = {}) {
  const targetFiles = Array.isArray(worktreeStatus?.targetFiles) ? worktreeStatus.targetFiles : [];
  const wtFiles = Array.isArray(worktreeStatus?.wtFiles) ? worktreeStatus.wtFiles : [];
  return [
    ...targetFiles.map((entry) => ({ ...entry, location: "target" })),
    ...wtFiles.filter((entry) => !entry.inScope).map((entry) => ({ ...entry, location: "worktree" })),
  ];
}

function keyName(key) {
  return typeof key?.name === "string" ? key.name.toLowerCase() : "";
}

function printableInput(str, key) {
  if (typeof str === "string" && /^[ -~]$/.test(str)) return str;
  if (typeof key?.sequence === "string" && /^[ -~]$/.test(key.sequence)) return key.sequence;
  const name = keyName(key);
  if (/^[ -~]$/.test(name)) return key?.shift ? name.toUpperCase() : name;
  return "";
}

function matchesHotkey(str, key, expected) {
  return printableInput(str, key).toLowerCase() === expected;
}

function digitInput(str, key) {
  const value = printableInput(str, key);
  return /^[1-9]$/.test(value) ? Number(value) : null;
}

function isEnterKey(str, key) {
  return str === "\r" || str === "\n" || keyName(key) === "return" || keyName(key) === "enter";
}

function isEscapeKey(str, key) {
  return str === "\x1b" || keyName(key) === "escape";
}

function isBackspaceKey(str, key) {
  return str === "\b" || str === "\x7f" || keyName(key) === "backspace";
}

function isSpaceKey(str, key) {
  return str === " " || keyName(key) === "space";
}

// ─── Display ────────────────────────────────────────────────────────────────


export class DisplayInputController {
  _drainQuestions() {
    if (!this._inputMode && this._questionQueue.length > 0) {
      this._startAnswering();
    }
  }

  _startAnswering() {
    if (this._questionQueue.length === 0) {
      this._inputMode = false;
      this._activeQ = null;
      return;
    }
    this._inputMode = "question";
    this._activeQ = this._questionQueue[0];
    this._inputBuf = "";
  }

  _startAnsweringAt(flatIdx) {
    let cursor = 0;
    for (const qSet of this._questionQueue) {
      const remaining = qSet.questions.length - qSet.currentIdx;
      if (flatIdx < cursor + remaining) {
        const targetIdx = qSet.currentIdx + (flatIdx - cursor);
        while (qSet.currentIdx < targetIdx) {
          qSet.answers.push({ question: qSet.questions[qSet.currentIdx], answer: "(skipped)" });
          qSet.currentIdx++;
        }
        this._inputMode = "question";
        this._activeQ = qSet;
        this._inputBuf = "";
        return;
      }
      cursor += remaining;
    }
    this._startAnswering();
  }

  _startAnsweringForJob(jobId) {
    const targetJobId = Number(jobId);
    if (!Number.isFinite(targetJobId)) return false;
    const qSet = this._questionQueue.find((entry) => Number(entry.jobId) === targetJobId);
    if (!qSet) return false;
    this._inputMode = "question";
    this._activeQ = qSet;
    this._inputBuf = "";
    return true;
  }

  _startInject() {
    this._inputMode = "inject";
    this._activeQ = null;
    this._inputBuf = "";
  }

  _getNudgeWorkers() {
    const nudgeableRoles = new Set(["researcher", "planner", "dev", "assessor", "artificer"]);
    return [...this.workers.entries()].filter(([, w]) => nudgeableRoles.has(w.role));
  }

  _getMonitorAgents() {
    if (typeof this._collectMonitorAgents !== "function") return [];
    try { return this._collectMonitorAgents(); } catch { return []; }
  }

  _setMonitorSelectionByIndex(index) {
    const agents = this._getMonitorAgents();
    if (agents.length === 0) return false;
    const idx = Math.max(0, Math.min(agents.length - 1, Number(index) || 0));
    this._monitorSelectedJobId = agents[idx].jobId;
    return true;
  }

  _cycleMonitorSelection(delta) {
    const agents = this._getMonitorAgents();
    if (agents.length === 0) return false;
    const current = agents.findIndex((agent) => agent.jobId === this._monitorSelectedJobId);
    const base = current >= 0 ? current : 0;
    const next = (base + delta + agents.length) % agents.length;
    this._monitorSelectedJobId = agents[next].jobId;
    return true;
  }

  _removeQuestionSet(q) {
    const idx = this._questionQueue.indexOf(q);
    if (idx !== -1) this._questionQueue.splice(idx, 1);
  }

  _submitAnswer() {
    if (!this._activeQ) return;
    const q = this._activeQ;
    const answer = this._inputBuf.trim();

    q.answers.push({
      question: q.questions[q.currentIdx],
      answer: answer || "(skipped)",
    });

    this._inputBuf = "";
    q.currentIdx++;

    if (q.currentIdx >= q.questions.length) {
      const answers = q.answers;
      q.resolve(answers);
      this._removeQuestionSet(q);
      const wiTag2 = q.workItemId ? `WI#${q.workItemId} ` : "";
      this.addEvent(`${C.green}\u2713 ${wiTag2}Answered ${answers.length} question(s) for job #${q.jobId}${C.reset}`);
      this._startAnswering();
    }
  }

  _skipQuestion() {
    if (!this._activeQ) return;
    const q = this._activeQ;

    q.answers.push({
      question: q.questions[q.currentIdx],
      answer: "(skipped)",
    });

    this._inputBuf = "";
    q.currentIdx++;

    if (q.currentIdx >= q.questions.length) {
      q.resolve(q.answers);
      this._removeQuestionSet(q);
      const wiTag3 = q.workItemId ? `WI#${q.workItemId} ` : "";
      this.addEvent(`${C.dim}${wiTag3}Questions for job #${q.jobId} done (some skipped)${C.reset}`);
      this._startAnswering();
    }
  }

  _submitInject() {
    const desc = this._inputBuf.trim();

    if (!desc) {
      this._inputMode = false;
      this._inputBuf = "";
      this.addEvent(`${C.dim}Inject canceled (empty)${C.reset}`);
      this._drainQuestions();
      return;
    }

    if (!this.onInject) {
      this._inputMode = false;
      this._inputBuf = "";
      this._drainQuestions();
      return;
    }
    try {
      this.onInject(desc);
      this._inputMode = false;
      this._inputBuf = "";
      this.addEvent(`${C.green}\u2713 Injected: ${desc.slice(0, 60)}${C.reset}`);
    } catch (err) {
      this._inputMode = "inject";
      this._inputBuf = desc;
      this.addEvent(`${C.red}Inject failed: ${err.message}; edit and press Enter to retry, Esc to cancel${C.reset}`);
      return;
    }
    this._drainQuestions();
  }

  _startAsk() {
    this._inputMode = "ask";
    this._activeQ = null;
    this._inputBuf = "";
  }

  _submitAsk() {
    const question = this._inputBuf.trim();

    if (!question) {
      this._inputMode = false;
      this._inputBuf = "";
      this.addEvent(`${C.dim}Ask canceled (empty)${C.reset}`);
      this._drainQuestions();
      return;
    }

    if (!this.onAsk) {
      this._inputMode = false;
      this._inputBuf = "";
      this._drainQuestions();
      return;
    }
    try {
      this.onAsk(question);
      this._inputMode = false;
      this._inputBuf = "";
      this.addEvent(`${C.green}\u2713 Ask: ${question.slice(0, 60)}${C.reset}`);
    } catch (err) {
      this._inputMode = "ask";
      this._inputBuf = question;
      this.addEvent(`${C.red}Ask failed: ${err.message}; edit and press Enter to retry, Esc to cancel${C.reset}`);
      return;
    }
    this._drainQuestions();
  }

  _startImage() {
    this._inputMode = "image";
    this._activeQ = null;
    this._inputBuf = "";
  }

  _submitImage() {
    const prompt = this._inputBuf.trim();

    if (!prompt) {
      this._inputMode = false;
      this._inputBuf = "";
      this.addEvent(`${C.dim}Image canceled (empty)${C.reset}`);
      this._drainQuestions();
      return;
    }

    if (!this.onImage) {
      this._inputMode = false;
      this._inputBuf = "";
      this._drainQuestions();
      return;
    }
    try {
      this.onImage(prompt);
      this._inputMode = false;
      this._inputBuf = "";
      this.addEvent(`${C.magenta}\u2713 Image: ${prompt.slice(0, 60)}${C.reset}`);
    } catch (err) {
      this._inputMode = "image";
      this._inputBuf = prompt;
      this.addEvent(`${C.red}Image failed: ${err.message}; edit and press Enter to retry, Esc to cancel${C.reset}`);
      return;
    }
    this._drainQuestions();
  }

  _cancelBufferedInput(label) {
    this._inputMode = false;
    this._inputBuf = "";
    this.addEvent(`${C.dim}${label} canceled${C.reset}`);
    this._drainQuestions();
  }

  _handleBufferedInputKeypress(str, key, { onReturn, onEscape }) {
    if (isEnterKey(str, key)) {
      onReturn();
    } else if (isEscapeKey(str, key)) {
      onEscape();
    } else if (isBackspaceKey(str, key)) {
      this._inputBuf = this._inputBuf.slice(0, -1);
    } else {
      const printable = printableInput(str, key);
      if (printable && !(key && key.ctrl) && !(key && key.meta)) {
        this._inputBuf += printable;
      }
    }
    this.requestRender({ force: true });
  }

  _submitNudge() {
    const correction = this._inputBuf.trim();
    if (!correction) {
      this._inputMode = false;
      this._inputBuf = "";
      this.addEvent(`${C.dim}Nudge canceled (empty)${C.reset}`);
      this._drainQuestions();
      return;
    }
    if (!this.onNudge) {
      this._inputMode = false;
      this._inputBuf = "";
      this.addEvent(`${C.dim}Nudge canceled${C.reset}`);
      this._drainQuestions();
      return;
    }
    try {
      this.onNudge(this._nudgeJobId, correction);
      this._inputMode = false;
      this._inputBuf = "";
      this.addEvent(`${C.cyan}\u270e Nudge sent to job #${this._nudgeJobId}: ${correction.slice(0, 60)}${C.reset}`);
      this._drainQuestions();
    } catch (err) {
      this._inputMode = "nudge_text";
      this._inputBuf = correction;
      this.addEvent(`${C.red}Nudge failed: ${err.message}; edit and press Enter to retry, Esc to cancel${C.reset}`);
    }
  }

  _onKeypress(str, key) {
    if (!key && !str) return;

    // Ctrl+C always triggers shutdown
    if (key && key.ctrl && key.name === "c") {
      this._emitSigint();
      return;
    }

    if (this._blockingOverlay) {
      if (
        this._blockingOverlay.kind === "wrapup"
        && this._blockingOverlay.allowEarlyExit === true
        && isEnterKey(str, key)
      ) {
        this.requestWrapUpEarlyExit?.();
        return;
      }
      this.requestRender({ force: true });
      return;
    }

    // ── Approval mode keys ──
    if (this._mode === "approval") {
      this._onApprovalKeypress(str, key);
      return;
    }

    // ── Normal mode ──
    if (this._inputMode === "question") {
      this._handleBufferedInputKeypress(str, key, {
        onReturn: () => this._submitAnswer(),
        onEscape: () => this._skipQuestion(),
      });

    } else if (this._inputMode === "inject") {
      this._handleBufferedInputKeypress(str, key, {
        onReturn: () => this._submitInject(),
        onEscape: () => this._cancelBufferedInput("Inject"),
      });

    } else if (this._inputMode === "ask") {
      this._handleBufferedInputKeypress(str, key, {
        onReturn: () => this._submitAsk(),
        onEscape: () => this._cancelBufferedInput("Ask"),
      });

    } else if (this._inputMode === "image") {
      this._handleBufferedInputKeypress(str, key, {
        onReturn: () => this._submitImage(),
        onEscape: () => this._cancelBufferedInput("Image"),
      });

    } else if (this._inputMode === "kill") {
      const digit = digitInput(str, key);
      if (isEscapeKey(str, key)) {
        this._inputMode = false;
        this._killJobIds = null;
        this._drainQuestions();
      } else if (digit != null) {
        const idx = digit - 1;
        const jobIds = typeof this._visibleKillJobIds === "function"
          ? this._visibleKillJobIds()
          : (Array.isArray(this._killJobIds) ? this._killJobIds : [...this.workers.keys()])
            .filter((jobId) => this.workers.has(jobId));
        if (idx < jobIds.length && this.onKill) {
          const jobId = jobIds[idx];
          this.onKill(jobId);
          this._inputMode = false;
          this._killJobIds = null;
          this._drainQuestions();
        }
      }
      this.requestRender({ force: true });

    } else if (this._inputMode === "killwi") {
      const digit = digitInput(str, key);
      if (isEscapeKey(str, key)) {
        this._inputMode = false;
        this._drainQuestions();
      } else if (digit != null) {
        const idx = digit - 1;
        if (this._killWIList && idx < this._killWIList.length && this.onKillWI) {
          const wi = this._killWIList[idx];
          this.onKillWI(wi.id);
          this.addEvent(`${C.red}\u2717 Canceled WI#${wi.id}: ${wi.title.slice(0, 50)}${C.reset}`);
          this._inputMode = false;
          this._drainQuestions();
        }
      }
      this.requestRender({ force: true });

    } else if (this._inputMode === "skip") {
      const digit = digitInput(str, key);
      if (isEscapeKey(str, key)) {
        this._inputMode = false;
        this._drainQuestions();
      } else if (digit != null) {
        const idx = digit - 1;
        if (this._skipJobList && idx < this._skipJobList.length && this.onSkipJob) {
          const job = this._skipJobList[idx];
          this.onSkipJob(job.id);
          this.addEvent(`${C.yellow}\u23ed WI#${job.work_item_id} skipped job #${job.id}: ${jobLabel(job.job_type, job.title).slice(0, 50)}${C.reset}`);
          this._inputMode = false;
          this._drainQuestions();
        }
      }
      this.requestRender({ force: true });

    } else if (this._inputMode === "nudge_select") {
      const digit = digitInput(str, key);
      if (isEscapeKey(str, key)) {
        this._inputMode = false;
        this._nudgeJobIds = null;
        this._drainQuestions();
      } else if (digit != null) {
        const idx = digit - 1;
        const jobIds = typeof this._visibleNudgeJobIds === "function"
          ? this._visibleNudgeJobIds()
          : (Array.isArray(this._nudgeJobIds) ? this._nudgeJobIds : this._getNudgeWorkers().map(([jobId]) => jobId))
            .filter((jobId) => this.workers.has(jobId));
        if (idx < jobIds.length) {
          this._nudgeJobId = jobIds[idx];
          this._nudgeJobIds = null;
          this._inputMode = "nudge_text";
          this._inputBuf = "";
        }
      }
      this.requestRender({ force: true });

    } else if (this._inputMode === "nudge_text") {
      this._handleBufferedInputKeypress(str, key, {
        onReturn: () => this._submitNudge(),
        onEscape: () => this._cancelBufferedInput("Nudge"),
      });

    } else {
      // Not in input mode
      const digit = digitInput(str, key);
      if (matchesHotkey(str, key, "m")) {
        this._rightMode = this._rightMode === "monitor" ? "log" : "monitor";
        if (this._rightMode === "monitor" && !this._monitorSelectedJobId) {
          this._setMonitorSelectionByIndex(0);
        }
        this.requestRender({ force: true });
      } else if (matchesHotkey(str, key, "q") && this._rightMode === "monitor") {
        this._rightMode = "log";
        this.requestRender({ force: true });
      } else if (this._rightMode === "monitor" && digit != null) {
        this._setMonitorSelectionByIndex(digit - 1);
        this.requestRender({ force: true });
      } else if (this._rightMode === "monitor" && (matchesHotkey(str, key, "<") || keyName(key) === "left")) {
        this._cycleMonitorSelection(-1);
        this.requestRender({ force: true });
      } else if (this._rightMode === "monitor" && (matchesHotkey(str, key, ">") || keyName(key) === "right")) {
        this._cycleMonitorSelection(1);
        this.requestRender({ force: true });
      } else if (this._rightMode === "monitor" && matchesHotkey(str, key, "n") && this.onNudge && this._monitorSelectedJobId) {
        this._inputMode = "nudge_text";
        this._nudgeJobId = this._monitorSelectedJobId;
        this._nudgeJobIds = null;
        this._inputBuf = "";
        this.requestRender({ force: true });
      } else if (this._rightMode === "monitor" && matchesHotkey(str, key, "t")) {
        this._monitorPromptLens = !this._monitorPromptLens;
        this.requestRender({ force: true });
      } else if (this._rightMode === "monitor" && matchesHotkey(str, key, "a") && this._startAnsweringForJob(this._monitorSelectedJobId)) {
        this.requestRender({ force: true });
      } else if (isEnterKey(str, key) && this._questionQueue.length > 0) {
        this._startAnswering();
        this.requestRender({ force: true });
      } else if (matchesHotkey(str, key, "q") && this._questionQueue.length > 0) {
        this._startAnswering();
        this.requestRender({ force: true });
      } else if (digit != null && this._questionQueue.length > 0) {
        this._startAnsweringAt(digit - 1);
        this.requestRender({ force: true });
      } else if (matchesHotkey(str, key, "i") && this.onInject) {
        this._startInject();
        this.requestRender({ force: true });
      } else if (matchesHotkey(str, key, "k") && this.onKill && this.workers.size > 0) {
        this._inputMode = "kill";
        this._killJobIds = [...this.workers.keys()];
        this.requestRender({ force: true });
      } else if (matchesHotkey(str, key, "x") && this.onKillWI) {
        this._inputMode = "killwi";
        this._killWIList = this._getActiveWorkItems();
        this.requestRender({ force: true });
      } else if (matchesHotkey(str, key, "s") && this.onSkipJob) {
        this._inputMode = "skip";
        this._skipJobList = this._getSkippableJobs();
        this.requestRender({ force: true });
      } else if (matchesHotkey(str, key, "p") && this.getPipelineData) {
        this._rightMode = this._rightMode === "pipeline" ? "log" : "pipeline";
        this._pipelineScroll = 0;
        this.requestRender({ force: true });
      } else if (matchesHotkey(str, key, "r") && this.onReviewPending) {
        try { this.onReviewPending(); }
        catch (err) { this.addEvent(`${C.red}Review failed: ${err.message}${C.reset}`); }
        this.requestRender({ force: true });
      } else if (matchesHotkey(str, key, "t") && this.getToolData) {
        this._rightMode = this._rightMode === "tools" ? "log" : "tools";
        this.requestRender({ force: true });
      } else if (key && key.name === "up" && this._rightMode === "pipeline") {
        if (this._pipelineScroll > 0) this._pipelineScroll--;
        this.requestRender({ force: true });
      } else if (key && key.name === "down" && this._rightMode === "pipeline") {
        this._pipelineScroll++;
        this.requestRender({ force: true });
      } else if (key && key.name === "tab" && this._rightMode === "tools") {
        this._toolsTab = (this._toolsTab + 1) % 3;
        this.requestRender({ force: true });
      } else if (digit != null && digit >= 1 && digit <= 3 && this._rightMode === "tools") {
        this._toolsTab = digit - 1;
        this.requestRender({ force: true });
      } else if (key && key.name === "up" && this._rightMode === "tools") {
        if (this._toolsTabScrolls[this._toolsTab] > 0) this._toolsTabScrolls[this._toolsTab]--;
        this._toolScroll = this._toolsTabScrolls[this._toolsTab];
        this.requestRender({ force: true });
      } else if (key && key.name === "down" && this._rightMode === "tools") {
        this._toolsTabScrolls[this._toolsTab]++;
        this._toolScroll = this._toolsTabScrolls[this._toolsTab];
        this.requestRender({ force: true });
      } else if (matchesHotkey(str, key, "n") && this.onNudge && this._getNudgeWorkers().length > 0) {
        this._inputMode = "nudge_select";
        this._nudgeJobId = null;
        this._nudgeJobIds = this._getNudgeWorkers().map(([jobId]) => jobId);
        this.requestRender({ force: true });
      } else if (matchesHotkey(str, key, "?") && this.onAsk) {
        this._startAsk();
        this.requestRender({ force: true });
      } else if (matchesHotkey(str, key, "g") && this.onImage) {
        this._startImage();
        this.requestRender({ force: true });
      }
    }
  }

  _startDiscardPicker(item, candidates) {
    this._approvalPicker = {
      itemId: item.wi.id,
      candidates: candidates.map((entry) => ({
        path: entry.path,
        status: entry.status,
        untracked: !!entry.untracked,
        location: entry.location || "worktree",
      })),
      selected: new Set(),
      cursor: 0,
    };
    this.requestRender({ force: true });
  }

  _startMemoryPicker(item) {
    const memories = Array.isArray(item.memoriesSurfaced) ? item.memoriesSurfaced : [];
    if (memories.length === 0) return;
    this._approvalMemoryPicker = {
      itemId: item.wi.id,
      memories,
      cursor: 0,
      textEntry: null, // { action: "correct", buffer: "" } while typing replacement text
    };
    this.requestRender({ force: true });
  }

  _onApprovalMemoryPickerKeypress(str, key) {
    const picker = this._approvalMemoryPicker;
    if (!picker) return;
    const memories = picker.memories;
    const current = memories[picker.cursor];

    if (picker.textEntry) {
      // Inline replacement-text entry for "correct".
      if (isEscapeKey(str, key)) {
        picker.textEntry = null;
      } else if (isEnterKey(str, key)) {
        const replacement = picker.textEntry.buffer.trim();
        if (replacement && current?.memoryId && this.onApprovalAction) {
          this.onApprovalAction(picker.itemId, {
            kind: "memory_action",
            action: "correct",
            memoryId: current.memoryId,
            replacement,
          });
          picker.textEntry = null;
        }
      } else if (key && (key.name === "backspace" || key.name === "delete")) {
        picker.textEntry.buffer = picker.textEntry.buffer.slice(0, -1);
      } else if (typeof str === "string" && str.length > 0 && !key?.ctrl && !key?.meta && str >= " ") {
        if (picker.textEntry.buffer.length < 500) picker.textEntry.buffer += str;
      }
      this.requestRender({ force: true });
      return;
    }

    if (isEscapeKey(str, key) || isEnterKey(str, key)) {
      this._approvalMemoryPicker = null;
    } else if ((key && key.name === "up") || matchesHotkey(str, key, "k")) {
      picker.cursor = Math.max(0, picker.cursor - 1);
    } else if ((key && key.name === "down") || matchesHotkey(str, key, "j")) {
      picker.cursor = Math.min(Math.max(0, memories.length - 1), picker.cursor + 1);
    } else if (current?.memoryId && !current._feedbackBusy && this.onApprovalAction) {
      if (matchesHotkey(str, key, "n")) {
        this.onApprovalAction(picker.itemId, { kind: "memory_action", action: "note", memoryId: current.memoryId });
      } else if (matchesHotkey(str, key, "s")) {
        this.onApprovalAction(picker.itemId, { kind: "memory_action", action: "suppress", memoryId: current.memoryId });
      } else if (matchesHotkey(str, key, "f")) {
        this.onApprovalAction(picker.itemId, { kind: "memory_action", action: "flag", memoryId: current.memoryId, reason: "contradicted" });
      } else if (matchesHotkey(str, key, "c")) {
        picker.textEntry = { action: "correct", buffer: "" };
      }
    }
    this.requestRender({ force: true });
  }

  _onApprovalPickerKeypress(str, key) {
    const picker = this._approvalPicker;
    if (!picker) return;
    if (isEscapeKey(str, key)) {
      this._approvalPicker = null;
      this.requestRender({ force: true });
      return;
    }
    if ((key && key.name === "up") || matchesHotkey(str, key, "k")) {
      picker.cursor = Math.max(0, picker.cursor - 1);
    } else if ((key && key.name === "down") || matchesHotkey(str, key, "j")) {
      picker.cursor = Math.min(Math.max(0, picker.candidates.length - 1), picker.cursor + 1);
    } else if (isSpaceKey(str, key)) {
      if (picker.candidates[picker.cursor]) {
        if (picker.selected.has(picker.cursor)) picker.selected.delete(picker.cursor);
        else picker.selected.add(picker.cursor);
      }
    } else if (matchesHotkey(str, key, "a")) {
      for (let i = 0; i < picker.candidates.length; i++) picker.selected.add(i);
    } else if (matchesHotkey(str, key, "n")) {
      picker.selected.clear();
    } else if (isEnterKey(str, key)) {
      const selectedIndexes = [...picker.selected]
        .filter((i) => picker.candidates[i])
        .sort((a, b) => a - b);
      const indexes = selectedIndexes.length > 0
        ? selectedIndexes
        : picker.candidates[picker.cursor] ? [picker.cursor] : [];
      const entries = indexes.map((i) => picker.candidates[i]).filter(Boolean);
      const paths = entries.map((entry) => entry.path).filter(Boolean);
      const locations = [...new Set(entries.map((entry) => entry.location || "worktree"))];
      const action = { kind: "discard_files", paths };
      if (!(locations.length === 1 && locations[0] === "worktree")) {
        action.files = entries.map((entry) => ({
          path: entry.path,
          location: entry.location || "worktree",
        }));
        if (locations.length === 1) action.location = locations[0];
      }
      const item = (this._approvalData || []).find((d) => d.wi.id === picker.itemId);
      this._approvalPicker = null;
      if (item && this.onApprovalAction) {
        this.onApprovalAction(item.wi.id, action);
      }
    }
    this.requestRender({ force: true });
  }

  _onApprovalKeypress(str, key) {
    if (!this._approvalData || this._approvalData.length === 0) return;
    if (typeof this._normalizeApprovalViewState === "function") {
      this._normalizeApprovalViewState();
    }

    if (this._approvalPicker) {
      this._onApprovalPickerKeypress(str, key);
      return;
    }

    if (this._approvalMemoryPicker) {
      this._onApprovalMemoryPickerKeypress(str, key);
      return;
    }

    if (this._approvalActionBusy) {
      this.requestRender({ force: true });
      return;
    }

    // Exit-confirm prompt is up: only y/Enter (leave) and n/Esc (stay) answer
    // it. Any other key dismisses the prompt and is handled normally below.
    if (this._approvalExitConfirm) {
      if (isEnterKey(str, key) || matchesHotkey(str, key, "y")) {
        this._approvalExitConfirm = false;
        if (this._approvalDone) { this._approvalDone({ canceled: false }); this._approvalDone = null; }
        this.requestRender({ force: true });
        return;
      }
      if (isEscapeKey(str, key) || matchesHotkey(str, key, "n")) {
        this._approvalExitConfirm = false;
        this.requestRender({ force: true });
        return;
      }
      this._approvalExitConfirm = false;
    }

    const digit = digitInput(str, key);
    if (key && key.name === "up") {
      if (this._approvalScroll > 0) this._approvalScroll--;
      this._approvalTabScrolls[this._approvalTab] = this._approvalScroll;
    } else if (key && key.name === "down") {
      this._approvalScroll++;
      this._approvalTabScrolls[this._approvalTab] = this._approvalScroll;
    } else if (key && key.name === "left") {
      if (this._approvalIdx > 0) {
        this._approvalIdx--;
        this._approvalTab = 0;
        this._approvalTabScrolls = [0, 0, 0, 0];
        this._approvalScroll = 0;
      }
    } else if (key && key.name === "right") {
      if (this._approvalIdx < this._approvalData.length - 1) {
        this._approvalIdx++;
        this._approvalTab = 0;
        this._approvalTabScrolls = [0, 0, 0, 0];
        this._approvalScroll = 0;
      }
    } else if (key && key.name === "tab") {
      // Cycle tabs forward (Shift+Tab for backward)
      if (key.shift) {
        this._approvalTab = (this._approvalTab + 3) % 4;
      } else {
        this._approvalTab = (this._approvalTab + 1) % 4;
      }
      this._approvalScroll = this._approvalTabScrolls[this._approvalTab];
    } else if (digit != null && digit >= 1 && digit <= 4) {
      this._approvalTab = digit - 1;
      this._approvalScroll = this._approvalTabScrolls[this._approvalTab];
    } else if (matchesHotkey(str, key, "a")) {
      const current = this._approvalData[this._approvalIdx];
      if (!current._decision && !current._isInfo) {
        const applied = this.onApprovalAction ? this.onApprovalAction(current.wi.id, "approve") : true;
        if (applied === false) return;
        current._decision = "approved";
        if (applied && typeof applied === "object" && applied.deferAdvance) return;
        this._advanceApproval();
      }
    } else if (matchesHotkey(str, key, "r")) {
      const current = this._approvalData[this._approvalIdx];
      if (!current._decision && !current._isInfo) {
        const applied = this.onApprovalAction ? this.onApprovalAction(current.wi.id, "reject") : true;
        if (applied === false) return;
        current._decision = "rejected";
        if (applied && typeof applied === "object" && applied.deferAdvance) return;
        this._advanceApproval();
      }
    } else if (matchesHotkey(str, key, "d")) {
      const current = this._approvalData[this._approvalIdx];
      if (!current._decision && !current._isInfo) {
        const applied = this.onApprovalAction ? this.onApprovalAction(current.wi.id, "delete") : true;
        if (applied === false) return;
        current._decision = "deleted";
        if (applied && typeof applied === "object" && applied.deferAdvance) return;
        this._advanceApproval();
      }
    } else if (matchesHotkey(str, key, "s")) {
      const current = this._approvalData[this._approvalIdx];
      if (!current._decision) {
        current._decision = "skipped";
        this._advanceApproval();
      }
    } else if (matchesHotkey(str, key, "c")) {
      const current = this._approvalData[this._approvalIdx];
      if (current && !current._decision && this.onApprovalAction) {
        this.onApprovalAction(current.wi.id, "commit_dirty");
      }
    } else if (matchesHotkey(str, key, "t")) {
      const current = this._approvalData[this._approvalIdx];
      if (current && !current._decision && this.onApprovalAction) {
        this.onApprovalAction(current.wi.id, "stash_target");
      }
    } else if (matchesHotkey(str, key, "m")) {
      const current = this._approvalData[this._approvalIdx];
      if (current) this._startMemoryPicker(current);
    } else if (matchesHotkey(str, key, "x")) {
      const current = this._approvalData[this._approvalIdx];
      const ws = current?.worktreeStatus;
      const candidates = reviewDiscardCandidates(ws);
      if (current && !current._decision && candidates.length > 0) {
        this._startDiscardPicker(current, candidates);
      } else if (current && !current._decision && this.onApprovalAction) {
        this.onApprovalAction(current.wi.id, "discard_dirty");
      }
    } else if (isEnterKey(str, key) || isEscapeKey(str, key)) {
      // Finish review (Enter is the deliberate finisher; Esc backs out too,
      // but never silently with work left undecided). Decisions were applied
      // the moment their key was pressed, so exiting just leaves the screen —
      // undecided items stay pending. Keep _mode = "approval" so the frame
      // keeps rendering the review layout (and the merging spinner) while the
      // caller awaits the background merge queue. The caller tears the
      // display down via stop() once queued git work has drained.
      const undecided = (this._approvalData || [])
        .filter((d) => !d._decision && !d._isInfo).length;
      if (undecided > 0) {
        this._approvalExitConfirm = true;
      } else if (this._approvalDone) {
        this._approvalDone({ canceled: false });
        this._approvalDone = null;
      }
    }
    this.requestRender({ force: true });
  }

  _advanceApproval() {
    if (!Array.isArray(this._approvalData) || this._approvalData.length === 0) {
      if (this._approvalDone) { this._approvalDone({ canceled: false }); this._approvalDone = null; }
      return;
    }
    if (typeof this._normalizeApprovalViewState === "function") {
      this._normalizeApprovalViewState();
    }

    // Move to next undecided item
    for (let i = 0; i < this._approvalData.length; i++) {
      const nextIdx = (this._approvalIdx + 1 + i) % this._approvalData.length;
      if (!this._approvalData[nextIdx]._decision) {
        const movingTo = nextIdx !== this._approvalIdx ? this._approvalData[nextIdx] : null;
        this._approvalIdx = nextIdx;
        this._approvalScroll = 0;
        this._approvalTab = 0;
        this._approvalTabScrolls = [0, 0, 0, 0];
        if (movingTo) {
          // Transient nav-bar cue so a rapid decision doesn't silently jump
          // the cursor to another work item under the user's fingers.
          this._approvalFlash = {
            text: `→ now reviewing WI#${movingTo.wi?.id ?? nextIdx + 1}`,
            at: Date.now(),
          };
        }
        return;
      }
    }
    // All decided — resolve the promise but keep approval mode active. The
    // caller awaits the merge queue after this, and we want the spinner UI
    // to stay visible until the queue drains instead of flickering to an
    // empty "normal" frame.
    if (this._approvalDone) { this._approvalDone({ canceled: false }); this._approvalDone = null; }
  }

}
