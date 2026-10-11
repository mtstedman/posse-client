import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createChainLedger } from "../../../shared/tools/functions/chain-ledger.js";
import { createNativeExplorationNoveltyTracker } from "../functions/deterministic-mcp/research-synthesis.js";

const RESEARCH_STATE_LIMIT = 5000;

function normalizedResearchStateExtras(data = {}) {
  const explorationSteps = Number(data.explorationSteps);
  const lastNovelEvidenceStep = Number(data.lastNovelEvidenceStep);
  const synthesisRequiredAt = data.synthesisRequiredAt ? String(data.synthesisRequiredAt) : null;
  return {
    explorationSteps: Number.isFinite(explorationSteps) && explorationSteps >= 0 ? Math.floor(explorationSteps) : 0,
    lastNovelEvidenceStep: Number.isFinite(lastNovelEvidenceStep) && lastNovelEvidenceStep >= 0
      ? Math.floor(lastNovelEvidenceStep)
      : 0,
    synthesisRequiredAt,
    synthesisReason: data.synthesisReason ? String(data.synthesisReason) : null,
    synthesisNoticeEmitted: synthesisRequiredAt ? data.synthesisNoticeEmitted !== false : false,
  };
}

// Owns one ledger, notice state, and novelty tracker per MCP session. The
// executable supplies live boot fields; persisted state uses a session-scoped
// filename so agent calls cannot clobber each other's research progress.
export class ResearchSessionStore {
  constructor({ getRuntime, execReadFile }) {
    this.getRuntime = getRuntime;
    this.execReadFile = execReadFile;
    this.sessions = new Map();
    this.current = null;
  }

  filePathFor(sessionKey) {
    const { isResearcherRole, mcpJobId, mcpAttemptId, workspaceCwd } = this.getRuntime();
    if (!isResearcherRole || !mcpJobId || !mcpAttemptId) return null;
    const token = crypto.createHash("sha256")
      .update(String(sessionKey || ""), "utf8")
      .digest("hex")
      .slice(0, 16);
    return path.join(workspaceCwd, ".posse", "research-state", `job-${mcpJobId}-attempt-${mcpAttemptId}-session-${token}.json`);
  }

  read(filePath) {
    if (!filePath) return null;
    try {
      if (!fs.existsSync(filePath)) return null;
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return data && typeof data === "object" ? data : null;
    } catch {
      return null;
    }
  }

  write(filePath, coreState, state) {
    if (!filePath) return;
    try {
      const researchLogDir = path.dirname(filePath);
      fs.mkdirSync(researchLogDir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(researchLogDir, 0o700); } catch { /* best effort */ }
      const { mcpJobId, mcpWorkItemId } = this.getRuntime();
      const data = {
        jobId: mcpJobId,
        workItemId: mcpWorkItemId,
        ...coreState,
        explorationSteps: state.explorationSteps,
        lastNovelEvidenceStep: state.lastNovelEvidenceStep,
        synthesisRequiredAt: state.synthesisRequiredAt,
        synthesisReason: state.synthesisReason,
        synthesisNoticeEmitted: state.synthesisNoticeEmitted,
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
      try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
    } catch { /* best effort */ }
  }

  createLedger(filePath) {
    const loaded = this.read(filePath);
    let ledgerState = null;
    const persist = filePath ? {
      load: () => loaded,
      save: (coreState) => this.write(filePath, coreState, ledgerState),
    } : null;
    const { workspaceCwd } = this.getRuntime();
    const ledger = createChainLedger({
      readFile: (args) => this.execReadFile(args, this.getRuntime().workspaceCwd, this.getRuntime().effectiveScopePredicates),
      cwd: workspaceCwd,
      persist,
    });
    Object.assign(ledger.state, normalizedResearchStateExtras(loaded || {}));
    ledgerState = ledger.state;
    return ledger;
  }

  createSession(sessionKey, filePath) {
    return {
      sessionKey: String(sessionKey || ""),
      filePath,
      ledger: this.createLedger(filePath),
      noticeFlags: { midpoint: false, curtain: false, extension: false },
      novelty: createNativeExplorationNoveltyTracker({
        scopeKey: `${String(sessionKey || "")}|repo:${this.getRuntime().workspaceCwd}`,
      }),
    };
  }

  select(sessionKey) {
    const key = String(sessionKey || "");
    let session = this.sessions.get(key);
    if (!session) {
      session = this.createSession(key, this.filePathFor(key));
      this.sessions.set(key, session);
      while (this.sessions.size > RESEARCH_STATE_LIMIT) {
        const oldest = this.sessions.keys().next().value;
        if (oldest == null || oldest === key) break;
        this.sessions.delete(oldest);
      }
    }
    this.current = session;
    return session;
  }

  release(sessionKey) {
    this.sessions.delete(String(sessionKey || ""));
  }

  get ledger() {
    return this.current.ledger;
  }

  get state() {
    return this.current.ledger.state;
  }

  get noticeFlags() {
    return this.current.noticeFlags;
  }

  get novelty() {
    return this.current.novelty;
  }

  save() {
    this.current?.ledger.save();
  }
}
