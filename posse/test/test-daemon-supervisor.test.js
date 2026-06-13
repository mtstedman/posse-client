// test/test-daemon-supervisor.test.js
//
// The daemon recovery ladder and its supervisor. Verifies, with scripted fake
// transports: (1) a request timeout abandons that request only — the host
// stays alive and keeps serving; (2) probe classifies any reply (even a
// structured error) as alive and only silence as wedged; (3) retire() fails
// pending requests with _transportGone, retires the transport gracefully, and
// the next request gets a fresh host; (4) the circuit breaker opens after a
// crash loop, refuses further spawns, and half-opens after the cooldown;
// (5) the supervisor registry dedupes by (kind, identity); (6) shutdownAll
// retires registered daemons and the own-ledger sweep reaps stray hosts.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { Daemon } from "../lib/classes/tools/daemon/Daemon.js";
import { DaemonSupervisor } from "../lib/classes/tools/daemon/supervisor.js";
import {
  recordDaemonSpawn,
  listOwnDaemonSpawns,
  reapOwnDaemonSpawns,
  setDaemonLedgerDirForTests,
} from "../lib/classes/tools/daemon/process-ledger.js";

/**
 * Scripted in-memory transport. `behavior(message, api)` decides per request:
 * reply, stay silent, or die. Tracks lifecycle calls for assertions.
 */
function fakeTransport(behavior) {
  const t = {
    alive: false,
    started: 0,
    killed: 0,
    retired: 0,
    retireGraceMs: null,
    messageCbs: [],
    exitCbs: [],
    start() { this.started++; this.alive = true; return true; },
    send(message) {
      behavior(message, {
        reply: (m) => { for (const cb of this.messageCbs) cb(m); },
        die: () => { this.alive = false; for (const cb of this.exitCbs) cb(); },
      });
    },
    onMessage(cb) { this.messageCbs.push(cb); },
    onExit(cb) { this.exitCbs.push(cb); },
    kill() { this.killed++; this.alive = false; },
    retire(graceMs) { this.retired++; this.retireGraceMs = graceMs; this.alive = false; },
    isAlive() { return this.alive; },
    hostPid() { return this.alive ? 4242 : null; },
  };
  return t;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

async function waitForDeath(pid, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

describe("daemon recovery ladder", () => {
  it("a timed-out request is abandoned without touching the host; later requests succeed", async () => {
    let calls = 0;
    const transport = fakeTransport((message, api) => {
      calls++;
      if (calls === 1) return; // first request: host is slow — never replies
      api.reply({ id: message.id, ok: true, data: "second" });
    });
    const daemon = new Daemon({ transportFactory: () => transport, timeoutMs: 50 });

    const first = await daemon.request({ method: "slow" });
    assert.equal(first._timedOut, true);
    assert.equal(transport.killed, 0, "timeout must not kill the host");
    assert.equal(transport.retired, 0, "timeout must not retire the host");
    assert.equal(transport.started, 1);

    const second = await daemon.request({ method: "fast" });
    assert.equal(second.ok, true);
    assert.equal(second.data, "second");
    assert.equal(transport.started, 1, "no respawn happened");
  });

  it("probe: any reply (even a structured error) is alive; only silence is wedged", async () => {
    const replies = fakeTransport((message, api) =>
      api.reply({ id: message.id, ok: false, error: { message: "unknown method" } }));
    const repliesDaemon = new Daemon({ transportFactory: () => replies });
    await repliesDaemon.request({ method: "warm" }); // spawn the host
    assert.equal(await repliesDaemon.probe({ method: "daemon.ping" }, { timeoutMs: 50 }), "alive");

    let probeCalls = 0;
    const silent = fakeTransport((message, api) => {
      probeCalls++;
      if (probeCalls === 1) api.reply({ id: message.id, ok: true, data: null });
      // After the first call: wedged — never reply again.
    });
    const silentDaemon = new Daemon({ transportFactory: () => silent });
    await silentDaemon.request({ method: "warm" });
    assert.equal(await silentDaemon.probe({ method: "daemon.ping" }, { timeoutMs: 50 }), "silent");
  });

  it("retire(): pending requests fail _transportGone, host drains gracefully, next request respawns", async () => {
    const transports = [];
    const factory = () => {
      const t = fakeTransport((message, api) => {
        if (message.method === "hang") return; // keep it pending
        api.reply({ id: message.id, ok: true, data: `host-${transports.length}` });
      });
      transports.push(t);
      return t;
    };
    const daemon = new Daemon({ transportFactory: factory, timeoutMs: 0, restartBackoffMs: 0 });

    const pending = daemon.request({ method: "hang" }, { timeoutMs: 5_000 });
    await new Promise((r) => setImmediate(r));
    daemon.retire({ graceMs: 123 });

    const failed = await pending;
    assert.equal(failed._transportGone, true, "in-flight request fails so idempotent callers retry");
    assert.equal(transports[0].retired, 1, "graceful retire, not kill");
    assert.equal(transports[0].retireGraceMs, 123);
    assert.equal(transports[0].killed, 0);

    const next = await daemon.request({ method: "again" });
    assert.equal(next.ok, true);
    assert.equal(transports.length, 2, "replacement host spawned on next request");
  });

  it("circuit breaker: opens after a crash loop, refuses spawns, half-opens after cooldown", async () => {
    let fakeNow = 1_000_000;
    let spawned = 0;
    const factory = () => {
      spawned++;
      // Crash-looping host: dies the moment it receives a request.
      return fakeTransport((message, api) => api.die());
    };
    const events = [];
    const daemon = new Daemon({
      transportFactory: factory,
      restartBackoffMs: 0,
      breakerMaxSpawns: 3,
      breakerWindowMs: 60_000,
      breakerCooldownMs: 300_000,
      onLifecycle: (e) => events.push(e.kind),
      now: () => fakeNow,
    });

    // Each request spawns a host that instantly crashes. The 4th spawn inside
    // the window trips the breaker.
    for (let i = 0; i < 4; i++) {
      fakeNow += 1_000;
      const res = await daemon.request({ method: "boom" });
      assert.equal(res._transportGone, true);
    }
    assert.equal(spawned, 4);
    assert.ok(events.includes("breaker_open"), "breaker_open lifecycle event emitted");
    assert.equal(daemon.breakerTrips, 1);

    // Open: no new spawns, requests fail fast.
    fakeNow += 1_000;
    const blocked = await daemon.request({ method: "boom" });
    assert.equal(blocked._transportGone, true);
    assert.equal(spawned, 4, "breaker open → no respawn");

    // Past the cooldown: half-open allows one probe spawn.
    fakeNow += 300_001;
    await daemon.request({ method: "boom" });
    assert.equal(spawned, 5, "half-open allows a comeback attempt");
    assert.ok(events.includes("breaker_half_open"));
  });

  it("retire-replacement spawns do not feed the crash breaker", async () => {
    let fakeNow = 1_000_000;
    let spawned = 0;
    const factory = () => {
      spawned++;
      return fakeTransport((message, api) => api.reply({ id: message.id, ok: true, data: spawned }));
    };
    const events = [];
    const daemon = new Daemon({
      transportFactory: factory,
      restartBackoffMs: 0,
      breakerMaxSpawns: 3,
      breakerWindowMs: 60_000,
      breakerCooldownMs: 300_000,
      onLifecycle: (e) => events.push(e.kind),
      now: () => fakeNow,
    });

    // Healthy hosts, deliberately retired over and over inside one breaker
    // window (the probe-driven path): the replacement spawns are not
    // crash-loop evidence and must never open the breaker.
    for (let i = 0; i < 6; i++) {
      fakeNow += 1_000;
      const res = await daemon.request({ method: "work" });
      assert.equal(res.ok, true, `request ${i} must succeed (breaker must stay closed)`);
      daemon.retire({});
    }
    assert.equal(spawned, 6);
    assert.equal(daemon.breakerTrips, 0, "deliberate retires opened the crash breaker");
    assert.ok(!events.includes("breaker_open"));
  });

  it("silenceMs() tracks the last message from the current host", async () => {
    let fakeNow = 1_000_000;
    let replyToFirstOnly = true;
    const transport = fakeTransport((message, api) => {
      if (replyToFirstOnly) {
        replyToFirstOnly = false;
        api.reply({ id: message.id, ok: true, data: null });
      }
      // After the first request: busy/silent.
    });
    const daemon = new Daemon({ transportFactory: () => transport, timeoutMs: 50, now: () => fakeNow });

    assert.equal(daemon.silenceMs(), Infinity, "no host yet — silence is unknowable");

    await daemon.request({ method: "warm" });
    assert.equal(daemon.silenceMs(), 0, "a reply just landed");

    fakeNow += 30_000;
    assert.equal(daemon.silenceMs(), 30_000);

    // A timed-out request does not advance the message clock.
    const timedOut = await daemon.request({ method: "slow" });
    assert.equal(timedOut._timedOut, true);
    assert.equal(daemon.silenceMs(), 30_000, "silence keeps counting from the last actual message");
  });
});

describe("daemon supervisor", () => {
  let ledgerDir;
  before(() => {
    ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-daemon-supervisor-"));
    setDaemonLedgerDirForTests(ledgerDir);
  });
  after(() => {
    setDaemonLedgerDirForTests(null);
    try { fs.rmSync(ledgerDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  beforeEach(() => {
    for (const f of fs.readdirSync(ledgerDir)) {
      try { fs.rmSync(path.join(ledgerDir, f), { force: true }); } catch { /* ignore */ }
    }
  });

  it("registry dedupes by (kind, identity) and routes lifecycle events", async () => {
    const supervisor = new DaemonSupervisor();
    let created = 0;
    const events = [];
    supervisor.onLifecycle((e) => events.push(e));
    const spec = (identity) => ({
      kind: "test",
      identity,
      label: `test:${identity}`,
      create: () => {
        created++;
        return new Daemon({
          label: `test:${identity}`,
          transportFactory: () => fakeTransport((m, api) => api.reply({ id: m.id, ok: true, data: null })),
        });
      },
    });

    const a1 = supervisor.daemon(spec("a"));
    const a2 = supervisor.daemon(spec("a"));
    const b = supervisor.daemon(spec("b"));
    assert.equal(a1, a2, "same identity → same daemon");
    assert.notEqual(a1, b, "different identity → different daemon");
    assert.equal(created, 2);

    await a1.request({ method: "warm" });
    assert.ok(events.some((e) => e.kind === "spawn" && e.label === "test:a"), "spawn event routed to supervisor");
    assert.equal(supervisor.list().length, 2);
  });

  it("ledger records threadId and label; reapOwnDaemonSpawns kills strays and clears entries", async () => {
    // A live stray (image-verified node process) plus an already-dead entry.
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
    sleeper.unref();
    recordDaemonSpawn(sleeper.pid, process.execPath, { label: "git:worker" });
    recordDaemonSpawn(999999, "posse-git.exe", { label: "git:worker" });

    const entries = listOwnDaemonSpawns();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].label, "git:worker");
    assert.equal(typeof entries[0].threadId, "number");

    const { killed } = reapOwnDaemonSpawns();
    assert.equal(killed, 1, "live stray killed; dead entry just dropped");
    assert.ok(await waitForDeath(sleeper.pid), "stray host is gone");
    assert.equal(listOwnDaemonSpawns().length, 0, "ledger empty after sweep");
  });

  it("reapOwnDaemonSpawns honors exceptPids", async () => {
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
    sleeper.unref();
    recordDaemonSpawn(sleeper.pid, process.execPath, { label: "spare" });
    try {
      const { killed } = reapOwnDaemonSpawns({ exceptPids: [sleeper.pid] });
      assert.equal(killed, 0);
      assert.ok(isAlive(sleeper.pid), "excepted pid untouched");
      assert.equal(listOwnDaemonSpawns().length, 1, "excepted entry retained");
    } finally {
      try { process.kill(sleeper.pid, "SIGKILL"); } catch { /* already dead */ }
      reapOwnDaemonSpawns();
    }
  });

  it("shutdownAll retires live daemons gracefully and sweeps the ledger", async () => {
    const supervisor = new DaemonSupervisor();
    const transport = fakeTransport((m, api) => api.reply({ id: m.id, ok: true, data: null }));
    const daemon = supervisor.daemon({
      kind: "test",
      identity: "shutdown",
      create: () => new Daemon({ label: "test:shutdown", transportFactory: () => transport }),
    });
    await daemon.request({ method: "warm" });
    assert.equal(transport.alive, true);

    // A stray from a "worker thread that never disposed".
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
    sleeper.unref();
    recordDaemonSpawn(sleeper.pid, process.execPath, { label: "thread-stray" });

    const summary = await supervisor.shutdownAll({ graceMs: 10 });
    assert.equal(summary.retired, 1, "registered live daemon retired");
    assert.equal(transport.retired, 1, "graceful retire, not kill");
    assert.ok(summary.reaped >= 1, "ledger stray reaped");
    assert.ok(await waitForDeath(sleeper.pid));
    assert.equal(listOwnDaemonSpawns().length, 0);
  });
});
