// test/test-daemon-process-ledger.test.js
//
// The hard process ledger that lets boot reap ProcessTransport daemon children
// orphaned by a crashed prior session. Verifies: a ledger owned by a DEAD pid
// gets its (image-verified) children killed and the file deleted; a ledger
// owned by a LIVE pid is left untouched; record/forget self-cleans the file.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

let ledgerDir;
let mod;

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

// A child that just sleeps, so we can observe it being reaped. Uses the node
// binary so the image-name check (which matches the recorded basename) passes.
function spawnSleeper() {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
  child.unref();
  return child;
}

async function waitForDeath(pid, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

// A pid that is (almost certainly) not alive — used as a fake crashed owner.
function deadPid() {
  for (let candidate = 999990; candidate > 990000; candidate--) {
    if (!isAlive(candidate)) return candidate;
  }
  return 999999;
}

describe("daemon process ledger / orphan reaper", () => {
  before(async () => {
    ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-daemon-ledger-"));
    mod = await import("../lib/classes/tools/daemon/process-ledger.js");
    mod.setDaemonLedgerDirForTests(ledgerDir);
  });
  after(() => {
    mod?.setDaemonLedgerDirForTests(null);
    try { fs.rmSync(ledgerDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  beforeEach(() => {
    for (const f of fs.readdirSync(ledgerDir)) {
      try { fs.rmSync(path.join(ledgerDir, f), { force: true }); } catch { /* ignore */ }
    }
  });

  it("reaps a dead owner's orphaned child and deletes the ledger", async () => {
    const child = spawnSleeper();
    assert.ok(isAlive(child.pid), "sleeper should be running");
    // A ledger owned by a dead pid, listing the live orphan (image = node).
    const owner = deadPid();
    const file = path.join(ledgerDir, `${owner}.json`);
    fs.writeFileSync(file, JSON.stringify([{ pid: child.pid, bin: path.basename(process.execPath), startedAt: Date.now() }]));

    const res = mod.reapOrphanedDaemons();
    assert.equal(res.killed, 1, "should kill exactly the one orphan");
    assert.equal(fs.existsSync(file), false, "stale ledger should be deleted");
    assert.equal(await waitForDeath(child.pid), true, "orphan should be dead");
  });

  it("leaves a live owner's ledger untouched", async () => {
    const child = spawnSleeper();
    // Owner = THIS process (alive). Reaper must skip its own / any live owner.
    const file = path.join(ledgerDir, `${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify([{ pid: child.pid, bin: path.basename(process.execPath), startedAt: Date.now() }]));

    const res = mod.reapOrphanedDaemons();
    assert.equal(res.killed, 0, "must not kill a live owner's children");
    assert.equal(fs.existsSync(file), true, "live owner's ledger must survive");
    assert.equal(isAlive(child.pid), true, "child must still be alive");

    try { process.kill(child.pid, "SIGKILL"); } catch { /* cleanup */ }
  });

  it("does not kill a recycled pid whose image no longer matches", async () => {
    // Record a bin that the live pid's image will NOT match → reaper skips it.
    const child = spawnSleeper();
    const owner = deadPid();
    const file = path.join(ledgerDir, `${owner}.json`);
    fs.writeFileSync(file, JSON.stringify([{ pid: child.pid, bin: "definitely-not-a-real-binary-xyz", startedAt: Date.now() }]));

    const res = mod.reapOrphanedDaemons();
    assert.equal(res.killed, 0, "image mismatch must prevent the kill");
    assert.equal(res.skipped, 1, "the mismatch should be counted as skipped");
    assert.equal(isAlive(child.pid), true, "the unrelated process must survive");

    try { process.kill(child.pid, "SIGKILL"); } catch { /* cleanup */ }
  });

  it("record then forget self-deletes the ledger when empty", () => {
    // Use this process's own ledger via the public API.
    mod.recordDaemonSpawn(424242, process.execPath);
    const own = path.join(ledgerDir, `${process.pid}.json`);
    assert.equal(fs.existsSync(own), true, "recording should create the ledger");
    mod.forgetDaemonSpawn(424242);
    assert.equal(fs.existsSync(own), false, "forgetting the last pid should delete the ledger");
  });
});
