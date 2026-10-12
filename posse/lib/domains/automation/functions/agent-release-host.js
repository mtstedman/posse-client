// Process helpers for the root release reconciler: one command runner, the
// account lookups that drop privilege for git, npm and probes, the run lock,
// the sandbox for unproven release code, and the journal line format.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { AGENT_RELEASE_CHILD_PATH, AGENT_RELEASE_COMMANDS } from "../../../catalog/agent-release.js";
import { SYSTEM_REGISTERED_AGENT } from "../../../catalog/registered-agent.js";
import { scrubSecretText } from "../../../shared/telemetry/functions/logging/scrub-secret-text.js";
import { demand } from "./policy.js";

/**
 * @typedef {{ uid?: number, gid?: number, env?: Record<string, string>, cwd?: string, input?: string | Buffer,
 *   timeoutMs?: number, maxBuffer?: number, encoding?: BufferEncoding | "buffer" }} RunOptions
 * @typedef {{ status: number | null, signal?: string | null, stdout: any, stderr: any, error?: Error }} RunResult
 */

/**
 * spawnSync with no shell. A non-zero exit is returned, never thrown; `uid`
 * and `gid` drop to that account (libuv also clears supplementary groups).
 *
 * @param {string} command @param {string[]} args @param {RunOptions} [options]
 * @returns {RunResult}
 */
export function runCommand(command, args, { uid, gid, env, cwd, input, timeoutMs, maxBuffer = 16 * 1024 * 1024, encoding = "utf8" } = {}) {
  const result = spawnSync(command, args, {
    ...(uid === undefined ? {} : { uid }), ...(gid === undefined ? {} : { gid }),
    env, cwd, input, timeout: timeoutMs, maxBuffer, encoding, killSignal: "SIGKILL",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error };
}

/** A short, secret-scrubbed reason for a failed command. */
export function commandFailure(label, result) {
  const detail = String(result?.stderr || result?.error?.message || result?.signal || "").trim().split("\n").slice(-4).join(" | ");
  return scrubSecretText(`${label} failed (exit ${result?.status ?? "none"})${detail ? `: ${detail}` : ""}`).slice(0, 600);
}

/**
 * @param {(command: string, args: string[], options?: RunOptions) => RunResult} run
 * @param {string | number} key an account name or uid
 * @returns {{ name: string, uid: number, gid: number, home: string }}
 */
export function lookupAccount(run, key) {
  const result = run(AGENT_RELEASE_COMMANDS.getent, ["passwd", String(key)]);
  demand(result.status === 0, `Unknown account: ${key}`, "invalid_request");
  const [name, , uid, gid, , home] = String(result.stdout || "").trim().split("\n")[0].split(":");
  demand(name && /^[0-9]+$/.test(uid) && /^[0-9]+$/.test(gid) && home?.startsWith("/"), `Unreadable account: ${key}`, "invalid_request");
  return { name, uid: Number(uid), gid: Number(gid), home };
}

/**
 * @param {string | number} key a group name or gid
 * @returns {{ name: string, gid: number, members: string[] }}
 */
export function lookupGroup(run, key) {
  const result = run(AGENT_RELEASE_COMMANDS.getent, ["group", String(key)]);
  const [name, , gid, members = ""] = String(result.stdout || "").trim().split("\n")[0].split(":");
  demand(result.status === 0 && name && /^[0-9]+$/.test(gid || ""), `Unknown group: ${key}`, "invalid_request");
  return { name, gid: Number(gid), members: members.split(",").filter(Boolean) };
}

/** @returns {number} */
export function lookupGroupId(run, name) {
  return lookupGroup(run, name).gid;
}

/**
 * Refuse an entry that anyone but its owner can write: a symlink, anything
 * other-writable, or anything group-writable through a group that is not the
 * owner's own private group (its primary group, listing no other member).
 * Checks the entry itself, not what lies below it. A missing entry passes.
 *
 * @param {{ run: Function, io: typeof fs, filename: string }} options
 */
export function assertOwnerOnlyWritable({ run, io, filename }) {
  const info = io.lstatSync(filename, { throwIfNoEntry: false });
  if (!info) return;
  demand(!info.isSymbolicLink(), `${filename} is a symlink`, "forbidden");
  demand(!(info.mode & 0o002), `${filename} is writable by every account`, "forbidden");
  if (!(info.mode & 0o020)) return;
  const owner = lookupAccount(run, info.uid);
  const group = lookupGroup(run, info.gid);
  demand(group.gid === owner.gid && group.members.every(member => member === owner.name),
    `${filename} is group-writable by ${group.name}, which is not ${owner.name}'s private group`, "forbidden");
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_NOTADB = 26;
// Held lock handles: a collected handle would close and silently drop its lock.
const HELD_LOCKS = new Set();

/**
 * Take the run lock: an exclusive SQLite transaction on `filename`, held
 * until the returned release function runs. The kernel drops the underlying
 * fcntl lock when the holder exits for any reason (crash, SIGKILL, reboot),
 * so a dead run never leaves a lock behind and a recycled PID never holds one.
 * A lock nobody releases is held until the process exits.
 *
 * @returns {(() => void) | null} the release function, or null while another process holds the lock
 */
export function tryExclusiveLock(filename) {
  for (let attempt = 0; ; attempt++) {
    const db = new DatabaseSync(filename);
    try {
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      db.close();
      if (error?.errcode === SQLITE_BUSY || error?.errcode === SQLITE_LOCKED) return null;
      // Not an SQLite file (an older lock format): nothing can hold it, so replace it once.
      if (error?.errcode !== SQLITE_NOTADB || attempt > 0) throw error;
      fs.rmSync(filename, { force: true });
      continue;
    }
    HELD_LOCKS.add(db);
    return () => {
      if (!HELD_LOCKS.delete(db)) return;
      try { db.exec("ROLLBACK"); } finally { db.close(); }
    };
  }
}

/**
 * systemd-run arguments that run unproven release code as the owner account
 * in a throwaway sandbox: private /tmp as HOME, working and data directory, a
 * read-only system, and no view of the live owner's data or sockets. The
 * caller appends the command.
 *
 * @param {{ timeoutSeconds: number, environmentFile?: string, ownerHome?: string, ownerRuntime?: string }} options
 */
export function sandboxedProbeArgs({ timeoutSeconds, environmentFile = "", ownerHome = SYSTEM_REGISTERED_AGENT.dataDir,
  ownerRuntime = SYSTEM_REGISTERED_AGENT.runtimeDir }) {
  return ["--quiet", "--wait", "--pipe", "--collect",
    `--uid=${SYSTEM_REGISTERED_AGENT.account}`, `--gid=${SYSTEM_REGISTERED_AGENT.clientGroup}`,
    ...(environmentFile ? ["-p", `EnvironmentFile=${environmentFile}`] : []),
    "-p", "WorkingDirectory=/tmp", "-p", "PrivateTmp=true", "-p", "NoNewPrivileges=true",
    "-p", "ProtectSystem=strict", "-p", "ProtectHome=yes",
    "-p", `InaccessiblePaths=-${ownerHome}`, "-p", `InaccessiblePaths=-${ownerRuntime}`,
    "-p", `RuntimeMaxSec=${timeoutSeconds + 30}`,
    "-E", "HOME=/tmp", "-E", "POSSE_AUTOMATION_DATA_DIR=/tmp/posse-agent-probe"];
}

/** The whole environment of an unprivileged child; nothing leaks from root. */
export function childEnv(account, extra = {}) {
  return { HOME: account.home, USER: account.name, LOGNAME: account.name, PATH: AGENT_RELEASE_CHILD_PATH, LANG: "C.UTF-8", ...extra };
}

/** One journal line: `posse-agent-release: <event> key=value ...`. */
export function formatReleaseLog(event, fields = {}) {
  const parts = Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}=${/^[A-Za-z0-9._:/@+#-]+$/.test(text) ? text : JSON.stringify(text)}`;
    });
  return scrubSecretText(`posse-agent-release: ${event}${parts.length ? ` ${parts.join(" ")}` : ""}`) + "\n";
}
