import fs from "fs";

export function worktreeLockTimeoutInfo(error, detail = "") {
  const text = [error?.message, error?.stderr, detail].filter(Boolean).join("\n");
  if (!/Timed out waiting for worktree lock/i.test(text)) return { timeout: false };
  const match = text.match(/Timed out waiting for worktree lock:\s*([^\r\n]+)/i)
    || text.match(/([^\s"'`]*worktree-locks[\\/][^\s"'`]+\.lock)/i);
  const lockPath = match?.[1] ? String(match[1]).trim() : null;
  // This runs on the error-handling path; the lock file may live on a
  // network mount that's slow or hung, so we keep the sync stat but
  // surface "unknown" rather than letting the diagnostics call block.
  // The detailed mtime/size diagnostics are best-effort metadata.
  let lockStat = null;
  if (lockPath) {
    try {
      const stat = fs.statSync(lockPath);
      lockStat = {
        exists: true,
        mtime: stat.mtime.toISOString(),
        age_ms: Math.max(0, Date.now() - stat.mtimeMs),
        size: stat.size,
      };
    } catch {
      lockStat = { exists: false };
    }
  }
  return { timeout: true, lockPath, lockStat };
}

/**
 * Async variant that races the stat against a short timeout — useful on
 * network mounts where fs.statSync can hang for many seconds. Falls back
 * to {exists: "unknown"} so the diagnostics still surface the lock path.
 */
export async function worktreeLockTimeoutInfoAsync(error, detail = "", { statTimeoutMs = 250 } = {}) {
  const text = [error?.message, error?.stderr, detail].filter(Boolean).join("\n");
  if (!/Timed out waiting for worktree lock/i.test(text)) return { timeout: false };
  const match = text.match(/Timed out waiting for worktree lock:\s*([^\r\n]+)/i)
    || text.match(/([^\s"'`]*worktree-locks[\\/][^\s"'`]+\.lock)/i);
  const lockPath = match?.[1] ? String(match[1]).trim() : null;
  let lockStat = null;
  if (lockPath) {
    let timer = null;
    const statPromise = fs.promises.stat(lockPath).then(
      (stat) => ({ ok: true, stat }),
      () => ({ ok: false }),
    );
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, timedOut: true }), statTimeoutMs);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([statPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);
      if (result.ok) {
        lockStat = {
          exists: true,
          mtime: result.stat.mtime.toISOString(),
          age_ms: Math.max(0, Date.now() - result.stat.mtimeMs),
          size: result.stat.size,
        };
      } else if (result.timedOut) {
        lockStat = { exists: "unknown", reason: `stat timed out after ${statTimeoutMs}ms` };
      } else {
        lockStat = { exists: false };
      }
    } catch {
      lockStat = { exists: false };
    }
  }
  return { timeout: true, lockPath, lockStat };
}

function firstMeaningfulCommitErrorLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function commitFailureOutputDetail(error = {}) {
  const stderr = String(error?.stderr || "").trim();
  const stdout = String(error?.stdout || "").trim();
  const parts = [];
  if (stderr) parts.push(`stderr:\n${stderr}`);
  if (stdout) parts.push(`stdout:\n${stdout}`);
  return parts.join("\n\n");
}

export function formatCommitFailureDetail(error = {}) {
  const hookOutput = String(error?.hookOutput || "").trim();
  const outputDetail = commitFailureOutputDetail(error);
  return [error?.message || String(error), hookOutput, outputDetail]
    .filter(Boolean)
    .join("\n\n");
}

export function formatCommitFailureSummary(error = {}) {
  const base = error?.message || String(error);
  const stderrLine = firstMeaningfulCommitErrorLine(error?.stderr);
  const stdoutLine = firstMeaningfulCommitErrorLine(error?.stdout);
  const extra = stderrLine || stdoutLine || error?.code || "";
  return extra && !String(base).includes(extra) ? `${base} - ${extra}` : base;
}
