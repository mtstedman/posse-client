import { C } from "../../../../shared/format/functions/colors.js";
import { _wrapQuestionBodyLines, _sanitizeDisplayLine } from "../../functions/display/helpers/formatters.js";
import { jobLabel } from "../../functions/display/helpers/job-status.js";



function questionContextSourceLines(context) {
  if (!context) return [];
  const raw = Array.isArray(context) ? context.join("\n") : String(context);
  return raw
    .split(/\r?\n/)
    .map((line) => _sanitizeDisplayLine(line).trimEnd())
    .map((line) => line.replace(/^\s{2,}/, "  "))
    .filter((line) => line.trim().length > 0);
}



function questionContextPriority(line) {
  const clean = String(line || "").trim().toLowerCase();
  if (/^(task|block reason|summary|notes):/.test(clean)) return 0;
  if (/^(files_touched|file_requests|criteria_check|status):/.test(clean)) return 1;
  if (/^-\s+/.test(clean)) return 2;
  return 3;
}



function wrapQuestionContextLine(line, width, firstLine = false) {
  const out = [];
  const safeWidth = Math.max(16, width);
  const firstPrefix = firstLine ? " Context: " : "          ";
  const nextPrefix = "          ";
  let text = String(line || "");
  if (text.length === 0) return [firstPrefix.trimEnd()];
  let prefix = firstPrefix;
  while (text.length > 0) {
    const available = Math.max(10, safeWidth - prefix.length);
    out.push(`${C.dim}${prefix}${text.slice(0, available)}${C.reset}`);
    text = text.slice(available);
    prefix = nextPrefix;
  }
  return out;
}



function buildQuestionContextDisplayLines(context, width, maxLines = 6) {
  const source = questionContextSourceLines(context);
  if (source.length === 0 || maxLines <= 0) return [];

  const sorted = source
    .map((line, idx) => ({ line, idx, priority: questionContextPriority(line) }))
    .sort((a, b) => (a.priority - b.priority) || (a.idx - b.idx));
  const selected = sorted
    .slice(0, Math.max(1, maxLines))
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => entry.line);

  const lines = [];
  for (let idx = 0; idx < selected.length; idx++) {
    const line = selected[idx];
    const wrapped = wrapQuestionContextLine(line, width, lines.length === 0);
    const remainingSelected = selected.length - idx - 1;
    const remainingSlots = maxLines - lines.length;
    const slotsForLine = Math.max(1, remainingSlots - remainingSelected);
    lines.push(...wrapped.slice(0, slotsForLine));
    if (lines.length >= maxLines) break;
  }
  if (source.length > selected.length && lines.length < maxLines) {
    lines.push(`${C.dim}          ... ${source.length - selected.length} more context line(s)${C.reset}`);
  }
  return lines;
}

function buildQuestionChoiceDisplayLine(choices, width) {
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const normalized = choices
    .slice(0, 9)
    .map((choice) => _sanitizeDisplayLine(String(choice || "")).trim())
    .filter(Boolean);
  const text = normalized
    .map((choice, index) => `[${index + 1}] ${choice}`)
    .join("  ");
  if (!text) return null;
  const prefix = " Options: ";
  const available = Math.max(10, width - prefix.length);
  const clipped = text.length > available ? `${text.slice(0, Math.max(1, available - 1))}…` : text;
  return ` ${C.cyan}${C.bold}Options:${C.reset} ${clipped}`;
}

export class DisplayBottomInputRenderer {


  // ── Bottom Input (full width) ─────────────────────────────────────────

  _buildBottomInput(width) {
    const lines = [];

    // ── Ask mode ──
    if (this._inputMode === "ask") {
      lines.push("");
      lines.push(` ${C.magenta}${C.bold}? Ask a Question${C.reset}  ${C.dim}Research-only (no dev tasks):${C.reset}`);
      lines.push("");
      const cursor = this._spinIdx % 2 === 0 ? "\u2588" : "\u258c";
      const maxBuf = width - 5;
      const displayBuf = this._inputBuf.length > maxBuf
        ? "\u2026" + this._inputBuf.slice(-(maxBuf - 1))
        : this._inputBuf;
      lines.push(` ${C.magenta}>${C.reset} ${displayBuf}${cursor}`);
      lines.push("");
      lines.push(` ${C.dim}[Enter] ask  [Esc] cancel${C.reset}`);
      return lines;
    }

    // ── Inject mode ──
    if (this._inputMode === "inject") {
      lines.push("");
      lines.push(` ${C.cyan}${C.bold}+ Inject Work Item${C.reset}  ${C.dim}Describe what you want built:${C.reset}`);
      lines.push("");
      const cursor = this._spinIdx % 2 === 0 ? "\u2588" : "\u258c";
      const maxBuf = width - 5;
      const displayBuf = this._inputBuf.length > maxBuf
        ? "\u2026" + this._inputBuf.slice(-(maxBuf - 1))
        : this._inputBuf;
      lines.push(` ${C.cyan}>${C.reset} ${displayBuf}${cursor}`);
      lines.push("");
      lines.push(` ${C.dim}[Enter] add  [Esc] cancel${C.reset}`);
      return lines;
    }

    // ── Image mode ──
    if (this._inputMode === "image") {
      lines.push("");
      lines.push(` ${C.magenta}${C.bold}\u{1f5bc} Generate Image${C.reset}  ${C.dim}Describe the image to generate:${C.reset}`);
      lines.push("");
      const cursor = this._spinIdx % 2 === 0 ? "\u2588" : "\u258c";
      const maxBuf = width - 5;
      const displayBuf = this._inputBuf.length > maxBuf
        ? "\u2026" + this._inputBuf.slice(-(maxBuf - 1))
        : this._inputBuf;
      lines.push(` ${C.magenta}>${C.reset} ${displayBuf}${cursor}`);
      lines.push("");
      lines.push(` ${C.dim}[Enter] generate  [Esc] cancel${C.reset}`);
      return lines;
    }

    // ── Kill mode ──
    if (this._inputMode === "kill") {
      lines.push("");
      lines.push(` ${C.red}${C.bold}\u26a1 Kill/Bump Worker${C.reset}  ${C.dim}Select worker to kill (moves to next attempt):${C.reset}`);
      let idx = 1;
      const killJobIds = this._visibleKillJobIds();
      for (const jobId of killJobIds) {
        const w = this.workers.get(jobId);
        if (!w) continue;
        const elapsed = ((Date.now() - w.startTime) / 1000).toFixed(0);
        const wiRef = w.workItemId ? `${C.blue}WI#${w.workItemId}${C.reset}` : `${C.dim}#${jobId}${C.reset}`;
        lines.push(` ${C.red}${C.bold}${idx}${C.reset} ${this._roleTag(w.role)} ${wiRef} ${w.activity || w.role} ${C.dim}${elapsed}s${C.reset}`);
        idx++;
      }
      lines.push("");
      lines.push(` ${C.dim}[1-${killJobIds.length}] kill  [Esc] cancel${C.reset}`);
      return lines;
    }

    // ── Kill WI mode ──
    if (this._inputMode === "killwi") {
      lines.push("");
      lines.push(` ${C.red}${C.bold}\u2717 Cancel Work Item${C.reset}  ${C.dim}Cancel all jobs and clean up branch:${C.reset}`);
      if (this._killWIList && this._killWIList.length > 0) {
        let idx = 1;
        for (const wi of this._killWIList) {
          const statusTag = `${C.dim}(${wi.status})${C.reset}`;
          lines.push(` ${C.red}${C.bold}${idx}${C.reset} ${C.blue}WI#${wi.id}${C.reset} ${_sanitizeDisplayLine(wi.title).slice(0, width - 25)} ${statusTag}`);
          idx++;
          if (idx > 9) break;
        }
        lines.push("");
        lines.push(` ${C.dim}[1-${Math.min(this._killWIList.length, 9)}] cancel WI  [Esc] back${C.reset}`);
      } else {
        lines.push(` ${C.dim}No active work items${C.reset}`);
        lines.push("");
        lines.push(` ${C.dim}[Esc] back${C.reset}`);
      }
      return lines;
    }

    // ── Skip job mode ──
    if (this._inputMode === "skip") {
      lines.push("");
      lines.push(` ${C.yellow}${C.bold}\u23ed Skip Task${C.reset}  ${C.dim}Mark as succeeded (unblocks downstream):${C.reset}`);
      if (this._skipJobList && this._skipJobList.length > 0) {
        let idx = 1;
        for (const j of this._skipJobList) {
          const statusTag = `${C.dim}(${j.status})${C.reset}`;
          const wiRef = `${C.blue}WI#${j.work_item_id}${C.reset}`;
          lines.push(` ${C.yellow}${C.bold}${idx}${C.reset} ${wiRef} ${C.dim}#${j.id}${C.reset} ${jobLabel(j.job_type, j.title).slice(0, width - 30)} ${statusTag}`);
          idx++;
          if (idx > 9) break;
        }
        lines.push("");
        lines.push(` ${C.dim}[1-${Math.min(this._skipJobList.length, 9)}] skip  [Esc] back${C.reset}`);
      } else {
        lines.push(` ${C.dim}No skippable tasks${C.reset}`);
        lines.push("");
        lines.push(` ${C.dim}[Esc] back${C.reset}`);
      }
      return lines;
    }

    // ── Nudge select mode ──
    if (this._inputMode === "nudge_select") {
      lines.push("");
      lines.push(` ${C.cyan}${C.bold}\u270e Nudge${C.reset}  ${C.dim}Select running job to redirect:${C.reset}`);
      let idx = 1;
      const nudgeJobIds = this._visibleNudgeJobIds();
      for (const jobId of nudgeJobIds) {
        const w = this.workers.get(jobId);
        if (!w) continue;
        const elapsed = ((Date.now() - w.startTime) / 1000).toFixed(0);
        const wiRef = w.workItemId ? `${C.blue}WI#${w.workItemId}${C.reset}` : `${C.dim}#${jobId}${C.reset}`;
        lines.push(` ${C.cyan}${C.bold}${idx}${C.reset} ${this._roleTag(w.role)} ${wiRef} ${w.activity || w.role} ${C.dim}${elapsed}s${C.reset}`);
        idx++;
      }
      lines.push("");
      lines.push(` ${C.dim}[1-${nudgeJobIds.length}] select  [Esc] cancel${C.reset}`);
      return lines;
    }

    // ── Nudge text mode ──
    if (this._inputMode === "nudge_text") {
      lines.push("");
      lines.push(` ${C.cyan}${C.bold}\u270e Nudge job #${this._nudgeJobId}${C.reset}  ${C.dim}What should it do instead?${C.reset}`);
      lines.push("");
      const cursor = this._spinIdx % 2 === 0 ? "\u2588" : "\u258c";
      const maxBuf = width - 5;
      const displayBuf = this._inputBuf.length > maxBuf
        ? "\u2026" + this._inputBuf.slice(-(maxBuf - 1))
        : this._inputBuf;
      lines.push(` ${C.cyan}>${C.reset} ${displayBuf}${cursor}`);
      lines.push("");
      lines.push(` ${C.dim}[Enter] kill & redirect  [Esc] cancel${C.reset}`);
      return lines;
    }

    // ── Question answering mode ──
    if (this._inputMode === "question" && this._activeQ) {
      const q = this._activeQ;
      const qNum = q.currentIdx + 1;
      const qTotal = q.questions.length;
      // q.questions[i] and q.context originate from worker role output
      // (parsed LLM output). Sanitize through the same filter the event log
      // uses so a crafted response cannot inject ANSI cursor-hide / alt-screen
      // sequences into the TUI.
      const qText = _sanitizeDisplayLine(q.questions[q.currentIdx] || "");
      const bodyLines = [];
      const qLineW = width - 5;
      const maxQuestionBodyLines = Math.max(6, Math.min(14, this.rows - 10));
      const choiceLine = buildQuestionChoiceDisplayLine(q.choices, qLineW);
      const choiceLines = choiceLine ? [choiceLine] : [];

      lines.push("");
      const maxContextLines = Math.max(0, Math.min(6, maxQuestionBodyLines - 4 - choiceLines.length));
      const contextLines = buildQuestionContextDisplayLines(q.context, qLineW, maxContextLines);
      bodyLines.push(...contextLines);

      const qHeader = ` ${C.yellow}${C.bold}\u26a0 Q${qNum}/${qTotal}${C.reset} ${C.dim}(job #${q.jobId})${C.reset}`;
      bodyLines.push(qHeader);
      const wrappedQuestionLines = _wrapQuestionBodyLines(qText, qLineW);
      bodyLines.push(...wrappedQuestionLines);

      if (bodyLines.length + choiceLines.length > maxQuestionBodyLines) {
        const reservedPrefix = contextLines.length + 1;
        const availableQuestionSlots = Math.max(2, maxQuestionBodyLines - reservedPrefix - choiceLines.length);
        const visibleQuestionSlots = Math.max(1, availableQuestionSlots - 1);
        const headCount = Math.max(1, Math.ceil(visibleQuestionSlots / 2));
        const tailCount = Math.max(0, visibleQuestionSlots - headCount);
        const preservedPrefix = bodyLines.slice(0, reservedPrefix);
        const questionHead = wrappedQuestionLines.slice(0, headCount);
        const questionTail = tailCount > 0 ? wrappedQuestionLines.slice(-tailCount) : [];
        bodyLines.length = 0;
        bodyLines.push(...preservedPrefix);
        bodyLines.push(...questionHead);
        bodyLines.push(` ${C.dim}... question clipped; showing beginning and end${C.reset}`);
        bodyLines.push(...questionTail);
      }
      bodyLines.push(...choiceLines);
      lines.push(...bodyLines);

      lines.push("");
      const cursor = this._spinIdx % 2 === 0 ? "\u2588" : "\u258c";
      const maxBuf = width - 5;
      const displayBuf = this._inputBuf.length > maxBuf
        ? "\u2026" + this._inputBuf.slice(-(maxBuf - 1))
        : this._inputBuf;
      lines.push(` ${C.green}>${C.reset} ${displayBuf}${cursor}`);
      lines.push("");
      const escapeAction = q.escapeAnswer ? q.escapeLabel || "best judgment" : "skip";
      lines.push(` ${C.dim}[Enter] submit  [Esc] ${escapeAction}${C.reset}`);
      return lines;
    }

    // ── Questions waiting (not in input mode) ──
    if (this._questionQueue.length > 0) {
      const totalQs = this._questionQueue.reduce((s, q) => s + (q.questions.length - q.currentIdx), 0);
      const qPreview = [];
      for (const qSet of this._questionQueue) {
        for (let i = qSet.currentIdx; i < qSet.questions.length && qPreview.length < 3; i++) {
          qPreview.push(_sanitizeDisplayLine(qSet.questions[i]).slice(0, 50));
        }
      }
      lines.push("");
      lines.push(` ${C.yellow}${C.bold}\u26a0 ${totalQs} question(s) waiting${C.reset}  ${C.dim}${qPreview.join("  |  ")}${C.reset}`);
      lines.push(` ${C.yellow}[Q] answer  [1-${Math.min(totalQs, 4)}] pick${C.reset}  ${this._buildHints()}`);
      return lines;
    }

    // ── Default: hints ──
    lines.push(` ${this._buildHints()}`);
    return lines;
  }



  _buildHints() {
    // Hints split into two zones separated by a dim divider:
    //   left  = input / inspection  (cyan + magenta keys)
    //   right = control / destruction (yellow + red keys, then quit)
    // Each hint colors the key letter in its action's semantic color and
    // leaves the label dim so the key reads at a glance.
    const hint = (key, label, keyColor) => `${keyColor}[${key}]${C.reset}${C.dim} ${label}${C.reset}`;
    const input = [];
    const inspect = [];
    const control = [];

    if (this.onInject) input.push(hint("i", "inject", C.cyan));
    if (this.onAsk) input.push(hint("?", "ask", C.cyan));
    if (this.onImage) input.push(hint("g", "image", C.magenta));

    if (this.getPipelineData) inspect.push(hint("p", this._rightMode === "pipeline" ? "log" : "pipeline", C.blue));
    if (this.onReviewPending) inspect.push(hint("r", "review", C.magenta));
    if (this.getToolData) inspect.push(hint("t", this._rightMode === "tools" ? "log" : "tools", C.blue));
    inspect.push(hint("m", this._rightMode === "monitor" ? "log" : "monitor", C.blue));

    if (this.onNudge && this.workers.size > 0) control.push(hint("n", "nudge", C.yellow));
    if (this.onSkipJob) control.push(hint("s", "skip task", C.yellow));
    if (this.onKill && this.workers.size > 0) control.push(hint("k", "kill", C.red));
    if (this.onKillWI) control.push(hint("x", "cancel WI", C.red));
    control.push(hint("Ctrl+C", "quit", C.red));

    const left = [...input, ...inspect].join("  ");
    const right = control.join("  ");
    const divider = (left && right) ? `  ${C.dim}│${C.reset}  ` : "";
    return `${left}${divider}${right}`;
  }
}
