import fs from "fs";
import path from "path";
import { getClaudeConfigDir } from "./auth-state.js";

export function buildClaudeInteractiveArgs(args = []) {
  const next = [];
  let hasPermissionMode = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || "");
    if (arg === "--dangerously-skip-permissions" || arg === "--allow-dangerously-skip-permissions") {
      continue;
    }
    if (arg === "--permission-mode") {
      hasPermissionMode = true;
      next.push(arg);
      if (i + 1 < args.length) next.push(String(args[++i]));
      continue;
    }
    if (arg.startsWith("--permission-mode=")) {
      hasPermissionMode = true;
    }
    next.push(arg);
  }
  if (!hasPermissionMode) next.push("--permission-mode", "dontAsk");
  return next;
}

export function getClaudeProjectSlugForCwd(cwd) {
  return path.resolve(cwd || process.cwd())
    .replaceAll(":", "-")
    .replaceAll("\\", "-")
    .replaceAll("/", "-");
}

export function getClaudeProjectDirForCwd(cwd) {
  return path.join(getClaudeConfigDir(), "projects", getClaudeProjectSlugForCwd(cwd));
}

export function listClaudeProjectLogFiles(cwd, { sinceMs = 0, sessionId = null } = {}) {
  const dir = getClaudeProjectDirForCwd(cwd);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const minMtime = Math.max(0, Number(sinceMs || 0) - 10_000);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(file);
        return {
          file,
          sessionId: entry.name.slice(0, -".jsonl".length),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((entry) => {
      if (sessionId && entry.sessionId === sessionId) return true;
      return entry.mtimeMs >= minMtime;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function findClaudeProjectLogFile(cwd, opts = {}) {
  return listClaudeProjectLogFiles(cwd, opts)[0] || null;
}

export function parseClaudeInteractiveLogSince(logPath, offset = 0) {
  const read = readFileUtf8FromOffset(logPath, offset);
  const assistantTexts = [];
  let turnFinished = false;
  let sessionId = null;
  let usage = {};
  for (const line of read.text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.sessionId === "string" && entry.sessionId.trim()) {
      sessionId = entry.sessionId.trim();
    }
    if (entry.type === "assistant") {
      const text = extractClaudeTextContent(entry.message?.content ?? entry.content).trim();
      if (text) assistantTexts.push(text);
      if (entry.message?.usage && typeof entry.message.usage === "object") usage = entry.message.usage;
    }
    if (entry.type === "system" && entry.subtype === "turn_duration") {
      turnFinished = true;
    }
  }
  return {
    output: assistantTexts.join("\n").trim(),
    assistantTextCount: assistantTexts.length,
    turnFinished,
    sessionId,
    usage,
    size: read.size,
    mtimeMs: read.mtimeMs,
  };
}

export function findClaudeInteractiveSessionState({ cwd, sessionId = null, pid = null, sinceMs = 0 } = {}) {
  const dir = path.join(getClaudeConfigDir(), "sessions");
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const minTime = Math.max(0, Number(sinceMs || 0) - 10_000);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(dir, entry.name);
    const state = readJsonFileQuiet(file);
    if (!state || state.kind !== "interactive") continue;
    const stateSessionId = typeof state.sessionId === "string" ? state.sessionId.trim() : "";
    const statePid = Number(state.pid);
    const updatedAt = Number(state.updatedAt || state.startedAt || 0);
    const sessionIdMatches = !!sessionId && !!stateSessionId && stateSessionId === sessionId;
    if (sessionId && stateSessionId && !sessionIdMatches) continue;
    if (!sessionIdMatches
      && Number.isFinite(pid) && pid > 0
      && Number.isFinite(statePid) && statePid > 0
      && statePid !== pid) continue;
    let score = 0;
    if (sessionId && stateSessionId === sessionId) score += 100;
    if (Number.isFinite(pid) && pid > 0 && statePid === pid) score += 50;
    if (cwd && pathsEquivalent(state.cwd, cwd)) score += 25;
    if (updatedAt >= minTime) score += 5;
    if (score <= 0) continue;
    candidates.push({ ...state, file, _score: score, _updatedAt: updatedAt });
  }
  candidates.sort((a, b) => (b._score - a._score) || (b._updatedAt - a._updatedAt));
  return candidates[0] || null;
}

function pathsEquivalent(left, right) {
  if (!left || !right) return false;
  try {
    return path.resolve(String(left)).toLowerCase() === path.resolve(String(right)).toLowerCase();
  } catch {
    return String(left).toLowerCase() === String(right).toLowerCase();
  }
}

function readJsonFileQuiet(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readFileUtf8FromOffset(filePath, offset = 0) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { text: "", size: 0, mtimeMs: 0 };
  }
  const start = Math.min(stat.size, Math.max(0, Math.floor(Number(offset) || 0)));
  const length = Math.max(0, stat.size - start);
  if (length <= 0) return { text: "", size: stat.size, mtimeMs: stat.mtimeMs };
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return { text: buffer.toString("utf8"), size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { text: "", size: stat.size, mtimeMs: stat.mtimeMs };
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function extractClaudeTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if ((part.type == null || part.type === "text") && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
