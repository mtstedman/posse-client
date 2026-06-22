import { C } from "../../../../shared/format/functions/colors.js";
import { getClaudeCommand } from "../../functions/claude/cli-discovery.js";
import {
  findClaudeInteractiveSessionState,
  findClaudeProjectLogFile,
  buildClaudeInteractiveArgs,
  parseClaudeInteractiveLogSince,
} from "../../functions/claude/interactive-logs.js";
import {
  getDefaultInteractiveCliBackend,
  stripTerminalControls,
} from "../../functions/shared/interactive-cli-session.js";
import {
  InteractiveCliSession,
  InteractiveCliUnavailableError,
} from "../InteractiveCliSession.js";

export class ClaudeInteractiveSession {
  constructor({
    args = [],
    cwd = null,
    env = process.env,
    timeoutMs = 15_000,
    backend = null,
    abortSignal = null,
    onLine = null,
    directOutput = false,
    color = C.cyan,
    startTime = Date.now(),
  } = {}) {
    const resolvedBackend = backend || getDefaultInteractiveCliBackend();
    if (!resolvedBackend) throw new InteractiveCliUnavailableError();

    const resolvedClaude = getClaudeCommand();
    const fullArgs = buildClaudeInteractiveArgs([
      ...resolvedClaude.args,
      ...(Array.isArray(args) ? args : []),
    ]);

    this.session = new InteractiveCliSession({
      command: resolvedClaude.command,
      args: fullArgs,
      cwd: cwd || process.cwd(),
      env,
      backend: resolvedBackend,
      timeoutMs,
      quietMs: 500,
      cols: 160,
      rows: 48,
    });
    this.timeoutMs = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 15_000;
    this.abortSignal = abortSignal;
    this.onLine = onLine;
    this.directOutput = !!directOutput;
    this.color = color;
    this.startTime = startTime;
    this.aborted = false;
    this.abortError = null;
    this.lastOutputLen = 0;
    this.progressTimer = null;
    this.rejectAbortWait = null;
    this.onAbort = () => this.#handleAbort();
    this.abortWait = new Promise((_, reject) => {
      this.rejectAbortWait = reject;
    });
    this.abortWait.catch(() => {});
  }

  async runProviderCall(prompt) {
    try {
      this.start();
      if (this.aborted) throw this.abortError;

      await this.#prepare({ timeoutMs: Math.min(this.timeoutMs, 30_000) });
      const promptLog = findClaudeProjectLogFile(this.session.cwd, { sinceMs: this.session.startedAt });
      const promptLogOffset = promptLog?.size || 0;
      const sentAt = Date.now();

      await this.#writePrompt(prompt);

      if (this.onLine || this.directOutput) {
        this.#startProgressTimer({ promptLog, promptLogOffset });
      }

      const completed = await this.#waitForCompletion({
        sinceMs: this.session.startedAt,
        sentAt,
        initialLog: promptLog,
        initialOffset: promptLogOffset,
      });

      this.#clearProgressTimer();
      this.#emitNewOutput(completed.output);

      await this.session.waitForQuiet({
        quietMs: 500,
        timeoutMs: Math.min(this.timeoutMs, 3_000),
      }).catch(() => {});
      const transcript = this.session.cleanTranscript();
      await this.#closeGracefully({ slashCommandsEnabled: false });
      return {
        output: completed.output,
        transcript,
        sessionHandle: completed.sessionId || null,
        logPath: completed.logPath || null,
        completedBy: completed.completedBy || null,
        usage: completed.usage || {},
        durationMs: Date.now() - this.startTime,
        exitCode: 0,
        signal: null,
      };
    } catch (err) {
      this.#clearProgressTimer();
      const transcript = this.session.cleanTranscript();
      if (this.aborted && this.abortError) throw this.abortError;
      err.transcript = transcript;
      throw err;
    } finally {
      if (this.abortSignal) {
        try { this.abortSignal.removeEventListener("abort", this.onAbort); } catch {}
      }
      await this.session.close({ gracefulMs: 500 });
    }
  }

  start() {
    this.session.start();
    if (this.abortSignal) {
      if (this.abortSignal.aborted) this.#handleAbort();
      else this.abortSignal.addEventListener("abort", this.onAbort, { once: true });
    }
    return this;
  }

  #handleAbort() {
    this.aborted = true;
    this.abortError = new Error("Claude interactive session aborted");
    this.abortError.name = "AbortError";
    try { this.session.proc?.kill?.(); } catch {}
    this.rejectAbortWait?.(this.abortError);
  }

  #emitNewOutput(output) {
    const clean = String(output || "");
    const next = clean.slice(this.lastOutputLen);
    this.lastOutputLen = clean.length;
    const visible = next.trim();
    if (!visible) return;
    for (const line of visible.split(/\n/).map((entry) => entry.trimEnd()).filter(Boolean)) {
      if (this.directOutput) process.stdout.write(`${this.color}|${C.reset} ${line}\n`);
      else if (this.onLine) this.onLine(line);
    }
  }

  #startProgressTimer({ promptLog, promptLogOffset }) {
    this.progressTimer = setInterval(() => {
      const logInfo = promptLog?.file
        ? { file: promptLog.file, sessionId: promptLog.sessionId }
        : findClaudeProjectLogFile(this.session.cwd, { sinceMs: this.session.startedAt });
      if (!logInfo?.file) return;
      const parsed = parseClaudeInteractiveLogSince(
        logInfo.file,
        promptLog?.file === logInfo.file ? promptLogOffset : 0,
      );
      if (parsed.output) this.#emitNewOutput(parsed.output);
    }, 500);
    this.progressTimer.unref?.();
  }

  #clearProgressTimer() {
    if (!this.progressTimer) return;
    clearInterval(this.progressTimer);
    this.progressTimer = null;
  }

  async #writePrompt(prompt) {
    const text = String(prompt || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const pasteSafe = text.replace(/\x1b\[201~/g, "");
    this.session.write(`\x1b[200~${pasteSafe}\x1b[201~`);
    await sleepInteractiveMs(1_000);
    this.session.write("\r");
    await sleepInteractiveMs(1_000);
    this.session.write("\r");
  }

  async #closeGracefully({ slashCommandsEnabled = true } = {}) {
    if (!slashCommandsEnabled) return;
    try {
      this.session.sendLine("/exit");
      await this.session.waitForQuiet({ quietMs: 300, timeoutMs: 1_500 }).catch(() => {});
    } catch {
      // Final cleanup is handled by InteractiveCliSession.close().
    }
  }

  async #prepare({ timeoutMs = 5_000 } = {}) {
    const deadline = Date.now() + Math.max(500, Math.min(timeoutMs, 30_000));
    let startupPromptAnsweredAt = 0;
    while (Date.now() < deadline) {
      if (await this.#answerStartupPrompt({ timeoutMs })) {
        startupPromptAnsweredAt = Date.now();
        await sleepInteractiveMs(100);
        continue;
      }
      const state = findClaudeInteractiveSessionState({
        cwd: this.session.cwd,
        pid: this.session?.proc?.pid,
        sinceMs: this.session.startedAt,
      });
      const inputReady = claudeInteractiveInputReady(this.session.getTranscript());
      const stateStatus = String(state?.status || "").toLowerCase();
      const stateUpdatedAt = Number(state?.updatedAt || 0);
      const stateIsOurs = Number(state?._score || 0) >= 50;
      if (stateIsOurs && stateStatus === "idle" && stateUpdatedAt >= this.session.startedAt - 1_000 && (!startupPromptAnsweredAt || inputReady)) {
        break;
      }
      const clean = stripTerminalControls(this.session.getTranscript());
      const quietForMs = Date.now() - this.session.lastDataAt;
      const settleAfterStartupMs = startupPromptAnsweredAt ? 6_000 : 0;
      const settledAfterStartup = !startupPromptAnsweredAt || Date.now() - startupPromptAnsweredAt >= settleAfterStartupMs;
      if (clean.trim() && quietForMs >= 500 && settledAfterStartup && (!startupPromptAnsweredAt || inputReady)) {
        break;
      }
      await sleepInteractiveMs(100);
    }
    await this.session.waitForQuiet({
      quietMs: 300,
      timeoutMs: Math.max(500, Math.min(timeoutMs, 3_000)),
    }).catch(() => {});
  }

  async #answerStartupPrompt({ timeoutMs = 2_000 } = {}) {
    if (await this.#answerBypassPrompt({ timeoutMs })) return true;
    if (await this.#answerSafetyPrompt({ timeoutMs })) return true;
    return false;
  }

  async #answerSafetyPrompt({ timeoutMs = 2_000 } = {}) {
    if (!claudeInteractiveSafetyPromptVisible(this.session.cleanTranscript())) return false;
    this.session.sendLine("");
    await this.session.waitForQuiet({
      quietMs: 500,
      timeoutMs: Math.max(500, Math.min(timeoutMs, 3_000)),
    }).catch(() => {});
    return true;
  }

  async #answerBypassPrompt({ timeoutMs = 2_000 } = {}) {
    if (!claudeInteractiveBypassPromptVisible(this.session.cleanTranscript())) return false;
    this.session.write("\x1b[B\r");
    await this.session.waitForQuiet({
      quietMs: 500,
      timeoutMs: Math.max(500, Math.min(timeoutMs, 3_000)),
    }).catch(() => {});
    return true;
  }

  async #waitForCompletion({
    sinceMs,
    sentAt,
    initialLog = null,
    initialOffset = 0,
  } = {}) {
    const waitLoop = async () => {
      const deadline = Date.now() + Math.max(1, Number(this.timeoutMs) || 1);
      let logInfo = initialLog || null;
      let logPath = logInfo?.file || null;
      let logOffset = logPath ? Math.max(0, Number(initialOffset) || 0) : 0;
      let sessionId = logInfo?.sessionId || null;
      let lastOutput = "";
      let lastParsed = null;
      let lastState = null;

      while (Date.now() <= deadline) {
        const foundLog = findClaudeProjectLogFile(this.session.cwd, { sinceMs, sessionId });
        if (!logPath && foundLog) {
          logInfo = foundLog;
          logPath = foundLog.file;
          logOffset = 0;
          sessionId = foundLog.sessionId || sessionId;
        } else if (
          foundLog
          && foundLog.file !== logPath
          && (!sessionId || foundLog.sessionId === sessionId || foundLog.mtimeMs >= sentAt - 1_000)
        ) {
          logInfo = foundLog;
          logPath = foundLog.file;
          logOffset = 0;
          sessionId = foundLog.sessionId || sessionId;
        } else if (foundLog) {
          logInfo = foundLog;
        }

        if (logPath) {
          lastParsed = parseClaudeInteractiveLogSince(logPath, logOffset);
          if (lastParsed.sessionId) sessionId = lastParsed.sessionId;
          if (lastParsed.output && lastParsed.output !== lastOutput) {
            lastOutput = lastParsed.output;
            this.#emitNewOutput(lastOutput);
          }
        }

        lastState = findClaudeInteractiveSessionState({
          cwd: this.session.cwd,
          sessionId,
          pid: this.session?.proc?.pid,
          sinceMs,
        });

        const stateStatus = String(lastState?.status || "").toLowerCase();
        const stateUpdatedAt = Number(lastState?.updatedAt || 0);
        const idleAfterPrompt = stateStatus === "idle" && stateUpdatedAt >= sentAt - 1_000;
        const waitingFor = String(lastState?.waitingFor || "");
        if (stateStatus === "waiting" && /permission/i.test(waitingFor) && Date.now() - sentAt > 2_000) {
          const err = new Error("Claude interactive session is waiting for permission prompt despite no-approval mode.");
          err.code = "CLAUDE_INTERACTIVE_PERMISSION_PROMPT";
          err.sessionState = lastState;
          throw err;
        }

        if (lastOutput && (idleAfterPrompt || lastParsed?.turnFinished)) {
          return {
            output: lastOutput,
            logPath,
            sessionId,
            sessionState: lastState,
            usage: lastParsed?.usage || {},
            completedBy: idleAfterPrompt ? "session-idle" : "turn-duration",
          };
        }

        const logQuiet = lastParsed?.mtimeMs ? Date.now() - lastParsed.mtimeMs >= 1_500 : false;
        const terminalQuiet = this.session?.lastDataAt ? Date.now() - this.session.lastDataAt >= 1_500 : false;
        if (lastOutput && !lastState && logQuiet && terminalQuiet) {
          return {
            output: lastOutput,
            logPath,
            sessionId,
            sessionState: null,
            usage: lastParsed?.usage || {},
            completedBy: "log-quiet",
          };
        }

        await sleepInteractiveMs(250);
      }
      throw new Error(`Timed out after ${Math.max(1, Number(this.timeoutMs) || 1)}ms waiting for Claude interactive idle state.`);
    };

    return Promise.race([waitLoop(), this.abortWait]);
  }
}

function claudeInteractiveSafetyPromptVisible(text) {
  return /quick\s*safety\s*check|do\s+you\s+trust|yes,\s*i\s+trust\s+this\s+folder|enter\s+to\s+confirm/i
    .test(stripTerminalControls(text));
}

function claudeInteractiveBypassPromptVisible(text) {
  const clean = stripTerminalControls(text);
  return /bypass\s*permissions\s*mode|yes,\s*i\s*accept|proceeding,\s*you\s*accept/i.test(clean);
}

function claudeInteractiveInputReady(text) {
  const clean = stripTerminalControls(text);
  return /(?:^|\n)>\s*(?:Try\b|["\u201c]|$)|don'?t\s*ask\s*on|\/effort/i.test(clean);
}

function sleepInteractiveMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}
