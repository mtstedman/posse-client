import { spawn } from "node:child_process";
import {
  SESSION_LINK_OWNERS,
  SESSION_OWNER_CHILD_ENV,
  SESSION_SYNC_STATES,
  sessionLeaseSec,
} from "../../../catalog/session-sync.js";
import { readRuntimeStatus, RUNTIME_STATUS_KEYS } from "../../queue/functions/runtime-status.js";
import { syncSharedTrunkFromOrigin } from "../../git/functions/shared-trunk.js";
import { createSharedTrunkPoller } from "../../scheduler/classes/SharedTrunkPoller.js";
import { pulseTokenManager } from "../../../shared/native/classes/PulseTokenManager.js";
import { validatePairingRemoteResponse } from "../functions/remote-client.js";
import {
  getPairingState,
  pairingProcessShouldStop,
  readoptPairingProcess,
  touchPairingState,
  updatePairingEnrollment,
} from "../functions/state.js";
import { requestSessionResume, setSessionHold } from "../functions/session-hold.js";
import { describeSessionPublishModes, sessionClosePreflight, setSessionAutoPublish } from "../functions/session-publish-command.js";
import { tickSessionAutoPublish } from "../functions/session-auto-publish.js";
import { readSessionLink, recordSessionLinkFailure, recordSessionLinkSuccess } from "../functions/session-link.js";
import { readSessionSync } from "../functions/session-sync.js";
import { formatSessionLanding, sessionPrompt } from "../functions/session-landing.js";
import { sessionSyncFeedLabel } from "../functions/sync-state.js";
import {
  clearPairingPeerSnapshot,
  collectPairingJobs,
  collectPairingPresence,
  collectPairingWorkItems,
  pairingPeerTrunkHints,
  readPairingPeerSnapshot,
  writePairingPeerSnapshot,
} from "../functions/work-items.js";
import { teamPolicyRegression, teamPolicyRegressionMessage } from "../functions/team-policy.js";
import {
  consoleSessionOwnership,
  pidProvablyDead,
  schedulerLockHolderLive,
  sessionCloseInProgress,
} from "../functions/monitor-ownership.js";
import { openPosseInNewWindow, SESSION_OWNER_LAUNCH_TTL_MS } from "../functions/session-owner-launch.js";
import {
  createSessionConsole,
  describeSessionWriteScope,
  diffPairingMembers,
  parseSessionConsoleLine,
  sessionConsoleHelp,
} from "../functions/session-console.js";
import {
  describeSessionHold,
  describeSessionResume,
  memberLabel,
  printHostConsoleMembers,
  printMemberChanges,
  printPeerActivityChanges,
} from "../functions/monitor-view.js";

// Five seconds is both the lease heartbeat and peer-work sync cadence.
const HEARTBEAT_MS = 5_000;
const HEARTBEAT_RETRY_MS = 2_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function leaseLapsedError(error, leaseSec, safeError) {
  const message = `Session heartbeats failed for longer than the Remote's ${leaseSec}s lease: ${safeError(error)}`;
  return Object.assign(new Error(message), {
    code: error?.code || "pairing_heartbeat_lease_lapsed",
    status: error?.status,
    cause: error,
  });
}

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/gu;

function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_PATTERN, "");
}

// The session console runs `posse add` / `posse go` in its own terminal: the
// same entry point this process was started with, in this checkout.
function spawnPosseInForeground(args, { cwd } = {}) {
  return spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, [SESSION_OWNER_CHILD_ENV]: String(process.pid) },
  });
}

export class PairingMonitor {
  constructor(remoteClient, stateId, options = {}, operations) {
    this.remoteClient = remoteClient;
    this.stateId = stateId;
    this.options = options;
    this.operations = operations;
  }

  async run() {
    const remoteClient = this.remoteClient;
    const stateId = this.stateId;
    const { assertPairingStatusMatches, admitPairingMember, kickPairingMember, safeError } = this.operations;
    const {
      projectDir = process.cwd(),
      C,
      json = false,
      input = process.stdin,
      output = process.stdout,
      sessionCode = null,
      heartbeatMs = HEARTBEAT_MS,
      retryMs = HEARTBEAT_RETRY_MS,
      tickMs = 250,
      nowMs = () => Date.now(),
      kill = process.kill.bind(process),
      trunkPoller = null,
      spawnPosse = spawnPosseInForeground,
      openPosseWindow = openPosseInNewWindow,
      platform = process.platform,
    } = this.options;
    let forceRequested = false;
    // A go opened in a new window boots (recovery, dependency repair) before it
    // takes the scheduler lock, possibly for minutes. Until then it still owns
    // the session: a second `go`, `close`, or Ctrl+C must not act as if no
    // run existed. Its process acknowledges the launch token with its pid at
    // boot; before that, a short grace covers the window starting.
    let goWindowOpenedAt = 0;
    let goWindowToken = null;
    const goWindowStarting = () => {
      if (!goWindowToken) return false;
      const launch = readRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_OWNER_LAUNCH);
      if (launch?.token !== goWindowToken) return false;
      const childPid = Number(launch.child_pid);
      if (Number.isSafeInteger(childPid) && childPid > 0) return !pidProvablyDead(childPid, kill);
      // The add-on-free npm repair runs before the child can record its pid and
      // has no useful short upper bound. Keep the same bounded ownership window
      // the child token itself accepts, rather than allowing a duplicate go or a
      // session close while that repair is still running.
      return nowMs() - goWindowOpenedAt < SESSION_OWNER_LAUNCH_TTL_MS;
    };
    // A posse command (`add`, `go`) this console handed the terminal to. Ctrl+C
    // then belongs to that command, never to the session.
    let foreground = null;
    let gracefulRequested = false;
    let lastTeamHandoffPollAt = 0;
    const seenPeerActivity = new Map();
    const seenMembers = new Map();
    let latestStatus = null;
    let latestMembers = [];
    let latestSync = null;
    let lastSyncState = null;
    // While posse go owns the session this console only observes: it never
    // heartbeats, fetches, or writes the peer snapshot, so exactly one local
    // process speaks for this clone.
    let observing = false;
    let observedOwner = null;
    let detached = false;
    // While it owns the session this console also keeps the checkout synced:
    // posse go exits when its queue is empty, and someone with nothing queued
    // must still get the others' work. A person's own checkout is often
    // mid-edit, so a blocked fast-forward is shown rather than raised as a gate.
    // posse go takes the poller over while it runs.
    const consolePoller = trunkPoller || createSharedTrunkPoller({
      projectDir,
      sync: (dir, options) => syncSharedTrunkFromOrigin(dir, { ...options, raiseBlockedGate: false }),
    });
    let consolePoll = null;
    let landingAfterHeartbeat = false;
    let landingShown = false;
    // Set once the loop has ended: nothing may start another poll while this
    // process closes, leaves or hands over.
    let stopping = false;
    // Monitoring starts right after the Remote accepted this clone, which counts
    // as the first proof that the lease is live.
    let lastHeartbeatOkMs = nowMs();
    const stop = () => {
      if (foreground) return;
      forceRequested = true;
    };
    // Closing the terminal must close and integrate like Ctrl+C. Output to the
    // gone terminal is dropped rather than allowed to crash the shutdown.
    const hangup = () => {
      for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
      forceRequested = true;
    };
    const stateAtStart = getPairingState(stateId);
    const role = stateAtStart?.role === "host" ? "host" : "member";
    const leaseSec = sessionLeaseSec(role);
    let log = (text = "") => console.log(text);
    const emit = (event, text) => {
      if (json) log(JSON.stringify(event));
      else log(text);
    };
    const readSync = (state) => {
      try {
        return readSessionSync({ state, snapshot: readPairingPeerSnapshot(), nowMs: nowMs() });
      } catch {
        return null;
      }
    };
    const reportSyncTransition = (state) => {
      latestSync = readSync(state);
      const sync = latestSync?.sync;
      if (!sync || sync.state === lastSyncState) return;
      // Nothing is known before the first fetch completes; say nothing yet.
      updatePrompt();
      if (lastSyncState == null && sync.state === SESSION_SYNC_STATES.UNKNOWN) return;
      const first = lastSyncState == null;
      lastSyncState = sync.state;
      // The first settled state is the moment the session is ready to use: the
      // session screen says it (and more) instead of a feed line.
      if (first && !json && !landingShown) {
        printLanding(state);
        return;
      }
      emit(
        { event: "pairing_sync", state: sync.state, label: sync.label, reasons: sync.reasons },
        `  ${C.cyan}[sync]${C.reset} ${sessionSyncFeedLabel(sync)}`,
      );
    };
    const peopleInSession = () => {
      const peers = readPairingPeerSnapshot()?.peers;
      const admitted = latestMembers.filter((member) => member?.state === "admitted").length;
      return 1 + Math.max(Array.isArray(peers) ? peers.length : 0, admitted);
    };
    const updatePrompt = () => {
      try {
        sessionConsole?.setPrompt(sessionPrompt({ sync: latestSync?.sync, peopleCount: peopleInSession(), observing }));
      } catch { /* the prompt is advisory */ }
    };
    const printLanding = (state = getPairingState(stateId)) => {
      if (json || !state) return;
      landingShown = true;
      latestSync = readSync(state) || latestSync;
      const snapshot = readPairingPeerSnapshot();
      const status = (observing ? snapshot : null) || latestStatus;
      let local = { work_items: [], jobs: [] };
      try {
        local = { work_items: collectPairingWorkItems(), jobs: collectPairingJobs() };
      } catch { /* an unreadable queue shows as idle */ }
      const lines = formatSessionLanding({
        role,
        sessionCode,
        branch: state.shared_branch,
        targetBranch: role === "host" ? state.original_branch : null,
        sync: latestSync?.sync,
        peersSync: latestSync?.peers_sync,
        peers: snapshot?.peers || status?.peers || [],
        members: latestMembers,
        local,
        scopeLabel: role === "host" ? null : describeSessionWriteScope(status?.scope_set || state.scopeSet),
        observing,
        publishLabel: describeSessionPublishModes(state),
        publishPaused: role === "host" ? state.auto_paused_reason || null : null,
      });
      log("");
      lines.forEach((line, index) => {
        const color = index === 0 ? C.bold
          : /^(Needs you|Waiting to join)/u.test(line) ? C.yellow
            : line.startsWith("Next:") ? C.cyan : "";
        log(`  ${color}${line}${color ? C.reset : ""}`);
      });
      updatePrompt();
    };
    // Run a posse command (`add`, `go`) in this terminal, then come back here.
    const runForeground = async (args) => {
      if (!sessionConsole?.interactive) {
        log(`  ${C.yellow}[session]${C.reset} run \`posse ${args.join(" ")}\` in another terminal in this folder`);
        return;
      }
      sessionConsole.suspend();
      let outcome = null;
      try {
        foreground = spawnPosse(args, { cwd: projectDir });
        outcome = await new Promise((resolve) => {
          foreground.once("error", (error) => resolve({ error }));
          foreground.once("exit", (code, signal) => resolve({ code, signal }));
        });
      } catch (error) {
        outcome = { error };
      } finally {
        foreground = null;
        const held = sessionConsole.resume()
          .filter((line) => !/posse go (now owns|finished;)/u.test(stripAnsi(line)));
        if (held.length > 0) {
          log(`  ${C.dim}While that ran:${C.reset}`);
          if (held.length > 10) log(`  ${C.dim}(${held.length - 10} earlier lines)${C.reset}`);
          for (const line of held.slice(-10)) log(line);
        }
      }
      if (outcome?.error) log(`  ${C.yellow}[session]${C.reset} could not run posse ${args[0]}: ${safeError(outcome.error)}`);
      // A posse go that took the session over hands it back on the next lap,
      // which shows the screen; one that never took it (nothing to do) ends here.
      if (!observing) printLanding();
    };
    const pollTrunk = (status = null, { force = false } = {}) => {
      if (consolePoll || stopping || observing) return;
      // Another process closing the session needs the merge lock for its final
      // sync; a console fetch holding it would fail that close.
      try {
        if (sessionCloseInProgress(getPairingState(stateId), kill, nowMs())) return;
      } catch { /* an unreadable claim row: skip this lap */ return; }
      const hints = status ? pairingPeerTrunkHints(status.peers || []) : undefined;
      consolePoll = consolePoller.poll({ force, ...(hints ? { hints } : {}) })
        .catch(() => null)
        .finally(() => {
          consolePoll = null;
          try {
            const current = getPairingState(stateId);
            if (current && !observing && !stopping) reportSyncTransition(current);
          } catch { /* the feed line is advisory */ }
          if (role === "host" && !observing && !stopping) {
            void tickSessionAutoPublish({
              projectDir,
              // Only after a heartbeat that found the session active.
              sessionActive: status?.status === "active",
              report: (text, { ok, action }) => log(`  ${ok ? C.green : C.yellow}[auto ${action}]${C.reset} ${text}`),
            });
          }
        });
    };
    const refreshHostMembers = async (state) => {
      if (state.role !== "host") return;
      try {
        const listed = await remoteClient.members(state.relay_token, { pendingOnly: false });
        latestMembers = Array.isArray(listed?.members) ? listed.members : [];
        printMemberChanges(log, C, diffPairingMembers(latestMembers, seenMembers), { json });
      } catch {
        // The member list is display only; the heartbeat is the lease.
      }
    };
    const runSessionConsoleCommand = async (parsed) => {
      const state = getPairingState(stateId);
      try {
        if (parsed.kind === "empty") return;
        if (parsed.kind === "invalid") {
          log(`  ${C.yellow}${parsed.message}${C.reset}`);
        } else if (parsed.kind === "help") {
          for (const line of sessionConsoleHelp(role, { observing })) log(`  ${C.dim}${line}${C.reset}`);
        } else if (parsed.kind === "status") {
          printLanding(state);
        } else if (parsed.kind === "add") {
          // Word by word, as a shell would pass them, so `add --oneshot fix it`
          // reaches posse add as a flag and a task.
          await runForeground(["add", ...(parsed.task ? parsed.task.split(/\s+/u) : [])]);
        } else if (parsed.kind === "go") {
          if (observing || schedulerLockHolderLive(kill) || goWindowStarting()) {
            log(`  ${C.yellow}[session]${C.reset} posse go is already running this session in another terminal; new tasks queued here wait for its next run.`);
            return;
          }
          // On Windows the run gets its own PowerShell window and this screen
          // stays: the host keeps watching members, admissions, and sync, and
          // takes the session back when that run ends. Elsewhere it runs here.
          if (platform === "win32" && sessionConsole?.interactive) {
            try {
              const opened = await openPosseWindow(["go"], { cwd: projectDir });
              goWindowToken = opened?.token || null;
              goWindowOpenedAt = nowMs();
              log(`  ${C.cyan}[session]${C.reset} posse go opened in a new PowerShell window; this screen stays here.`);
              return;
            } catch (error) {
              log(`  ${C.yellow}[session]${C.reset} could not open a new window (${safeError(error)}); running posse go here instead.`);
            }
          }
          await runForeground(["go"]);
        } else if (parsed.kind === "members") {
          printHostConsoleMembers(log, latestMembers);
        } else if (parsed.kind === "merge" || parsed.kind === "deploy") {
          // A child owns the terminal while the host reads and approves, so
          // Ctrl+C there cancels the merge instead of force-closing the session.
          await runForeground(["session", parsed.kind]);
        } else if (parsed.kind === "auto") {
          if (parsed.which) {
            const result = setSessionAutoPublish({ which: parsed.which, value: parsed.value, stateId });
            log(`  ${C.cyan}[session]${C.reset} auto ${parsed.which} ${result.mode === "auto" ? "on: it runs as work lands, without asking" : "off: it waits for your approval"}`);
          }
          const current = getPairingState(stateId);
          log(`  ${C.cyan}[session]${C.reset} ${describeSessionPublishModes(current)}`);
          if (current?.auto_paused_reason) log(`  ${C.yellow}[session]${C.reset} auto paused: ${current.auto_paused_reason}`);
        } else if (parsed.kind === "hold") {
          const held = setSessionHold({ stateId, reason: parsed.reason || null });
          log(held.ok
            ? `  ${C.cyan}[sync]${C.reset} ${describeSessionHold(held.hold)}`
            : `  ${C.yellow}[sync]${C.reset} Hold not set: ${held.reason}`);
        } else if (parsed.kind === "resume") {
          const resumed = requestSessionResume({ stateId });
          log(`  ${resumed.ok && resumed.resumed ? C.cyan : C.yellow}[sync]${C.reset} ${describeSessionResume(resumed)}`);
          if (resumed.ok && resumed.resumed && !observing) pollTrunk(latestStatus);
        } else if (parsed.kind === "admit") {
          log(`  ${C.cyan}[session]${C.reset} admitting ${parsed.code}...`);
          const admitted = await admitPairingMember({ state, code: parsed.code, projectDir, remoteClient });
          log(`  ${C.green}[session]${C.reset} admitted ${admitted.member ? `${memberLabel(admitted.member)} with ` : ""}`
            + `${admitted.countersign}; they are checking out ${state.shared_branch}`);
          await refreshHostMembers(state);
          printLanding(state);
        } else if (parsed.kind === "kick") {
          const matches = latestMembers.filter((member) => String(member.id).startsWith(parsed.id));
          if (matches.length !== 1) {
            log(`  ${C.yellow}[session]${C.reset} ${matches.length ? "Several" : "No"} members match "${parsed.id}"; type members to see ids`);
            return;
          }
          await kickPairingMember({ state, memberId: matches[0].id, projectDir, remoteClient });
          log(`  ${C.yellow}[session]${C.reset} removed ${memberLabel(matches[0])}`);
          await refreshHostMembers(state);
        }
      } catch (error) {
        log(`  ${C.yellow}[session]${C.reset} ${safeError(error)}`);
      }
    };
    let commandChain = Promise.resolve();
    const sessionConsole = !json
      ? createSessionConsole({
          input,
          output,
          onLine: (line) => {
            const parsed = parseSessionConsoleLine(line, { role });
            if (parsed.kind === "leave") {
              log(`  ${C.cyan}[session]${C.reset} leaving the session…`);
              gracefulRequested = true;
              return;
            }
            if (parsed.kind === "close") {
              if (observing || schedulerLockHolderLive(kill) || goWindowStarting()) {
                log(`  ${C.yellow}[session]${C.reset} posse go owns the session; close from the run screen (u → close), or stop posse go first.`);
                return;
              }
              // A close that would fail after mid-session merges is refused
              // while the session can still carry on.
              commandChain = commandChain.then(async () => {
                const blocked = await sessionClosePreflight(projectDir, getPairingState(stateId));
                if (blocked) log(`  ${C.yellow}[session]${C.reset} Not closing: ${blocked}`);
                else gracefulRequested = true;
              });
              return;
            }
            // One command at a time; a slow admit must not interleave with a kick.
            commandChain = commandChain.then(() => runSessionConsoleCommand(parsed));
          },
          onInterrupt: () => { forceRequested = true; },
          onHangup: () => hangup(),
        })
      : null;
    if (sessionConsole) log = sessionConsole.print;
    // on, not once: a Ctrl+C while a foreground child (add, go, merge, deploy)
    // owns the terminal must not use up the handler, or the next one would hit
    // Node's default and kill the console without a close.
    process.on("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("SIGHUP", hangup);
    const waitForNextLap = async (ms) => {
      for (let elapsed = 0; elapsed < ms; elapsed += tickMs) {
        if (forceRequested || gracefulRequested || pairingProcessShouldStop(stateId)) break;
        await sleep(tickMs);
      }
    };
    try {
      while (!forceRequested && !gracefulRequested && !pairingProcessShouldStop(stateId)) {
        let state = getPairingState(stateId);
        let ownership = consoleSessionOwnership(state, kill, nowMs());
        if (ownership === "vacant") {
          // posse go stopped heartbeating (exited, or sits in its wrap-up
          // screen): take the heartbeat back unless another process adopted the
          // session (or it ended) since it was read.
          const link = readSessionLink({ stateId });
          if (!readoptPairingProcess(stateId, { fromPid: state?.process_pid ?? null })) {
            await waitForNextLap(tickMs);
            continue;
          }
          ownership = "self";
          state = getPairingState(stateId);
          if (observing) {
            observing = false;
            // The lease runs from the last heartbeat that actually succeeded,
            // whichever process sent it.
            const lastOkMs = Date.parse(String(link?.last_ok_at || ""));
            lastHeartbeatOkMs = Number.isFinite(lastOkMs) ? lastOkMs : nowMs();
            emit(
              { event: "pairing_owner", owner: "console" },
              `  ${C.green}[session]${C.reset} posse go finished; this console is running the session again`,
            );
            // Shown after this console's first heartbeat as owner, once the
            // link, the peer snapshot and the fetch owner are its own again.
            landingAfterHeartbeat = !foreground;
          }
        }
        if (ownership === "scheduler" || ownership === "closing") {
          const ownerLabel = ownership === "closing" ? "closing" : "scheduler";
          if (!observing || observedOwner !== ownerLabel) {
            observing = true;
            observedOwner = ownerLabel;
            emit(
              { event: "pairing_owner", owner: ownerLabel },
              ownership === "closing"
                ? `  ${C.yellow}[session]${C.reset} the session is closing in another process; this console stays attached`
                : `  ${C.cyan}[session]${C.reset} posse go now owns the session; this console stays attached`,
            );
          }
          // Read-only view of what the scheduler maintains.
          const snapshot = readPairingPeerSnapshot();
          if (snapshot) printPeerActivityChanges(C, snapshot, seenPeerActivity, { json, log });
          await refreshHostMembers(state);
          reportSyncTransition(state);
          await waitForNextLap(heartbeatMs);
          continue;
        }
        let status;
        // A CLI close or scheduler adoption can finish while the heartbeat is
        // in flight. Its result belongs only to the owner that requested it.
        const ownsHeartbeat = () => {
          const current = getPairingState(stateId);
          return current?.phase === "active" && Number(current.process_pid) === process.pid
            && current.remote_session_id === state.remote_session_id
            && current.relay_token === state.relay_token;
        };
        try {
          const response = await remoteClient.heartbeat(state.relay_token, collectPairingPresence(projectDir));
          if (!ownsHeartbeat()) continue;
          status = validatePairingRemoteResponse(
            "heartbeat",
            response,
          );
          assertPairingStatusMatches(state, status);
          const nextScope = status.scope_set || {};
          const scopeChanged = JSON.stringify(nextScope) !== JSON.stringify(state.scopeSet || {});
          // Remote is authoritative for this policy but may never walk it
          // backwards; the scheduler session monitor enforces the same rule.
          const policyRegression = teamPolicyRegression(state, status);
          if (policyRegression) {
            throw Object.assign(new Error(teamPolicyRegressionMessage(policyRegression)), {
              code: "pairing_team_policy_regressed",
            });
          }
          const teamPolicyChanged = status.submission_approval_enabled != null
            && (Number(status.submission_approval_enabled) !== Number(state.submission_approval_enabled)
              || status.submission_policy_revision !== Number(state.submission_approval_revision));
          updatePairingEnrollment(state.id, {
            phase: "active",
            scopeSet: nextScope,
            computePolicy: status.compute_policy,
            integrationPolicy: status.integration_policy,
            enrollmentOpen: status.enrollment_open,
            submissionApprovalEnabled: status.submission_approval_enabled,
            submissionPolicyRevision: status.submission_policy_revision,
            teamPublicationMode: status.team_publication_mode,
            teamPublicationRevision: status.team_publication_revision,
          });
          if (scopeChanged || teamPolicyChanged) {
            pulseTokenManager.clearAuthentication();
            const { invalidateVerifiedTeamGrantCache } = await import("../functions/team-submissions.js");
            if (!ownsHeartbeat()) continue;
            invalidateVerifiedTeamGrantCache();
          }
          touchPairingState(stateId);
          lastHeartbeatOkMs = nowMs();
          recordSessionLinkSuccess({
            stateId, owner: SESSION_LINK_OWNERS.CONSOLE, leaseSec, nowMs: lastHeartbeatOkMs,
          });
          writePairingPeerSnapshot(status);
          if (state.role === "host" && status.submission_approval_enabled === true
            && Date.now() - lastTeamHandoffPollAt >= 15_000) {
            lastTeamHandoffPollAt = Date.now();
            const { reconcileTeamFileHandoff } = await import("../functions/team-submissions.js");
            const handoff = await reconcileTeamFileHandoff({
              projectDir, remoteClientFactory: () => remoteClient,
            });
            if (handoff.handedOff && !json) {
              log(`  ${C.green}[session handoff]${C.reset} ${handoff.predecessorWorkItemId} -> ${handoff.successorWorkItemId} (${handoff.acceptedOid.slice(0, 8)})`);
            }
            if (Array.isArray(handoff.expiredSuccessors) && handoff.expiredSuccessors.length && !json) {
              log(`  ${C.yellow}[session handoff]${C.reset} expired stale file request(s) ${handoff.expiredSuccessors.join(", ")}; the member must request again`);
            }
          }
          printPeerActivityChanges(C, status, seenPeerActivity, { json, log });
          latestStatus = status;
          await refreshHostMembers(state);
          if (!ownsHeartbeat()) continue;
          if (status.status === "active") pollTrunk(status);
          if (landingAfterHeartbeat) {
            landingAfterHeartbeat = false;
            printLanding(state);
          }
        } catch (error) {
          if (!ownsHeartbeat()) continue;
          recordSessionLinkFailure({ stateId, owner: SESSION_LINK_OWNERS.CONSOLE, leaseSec, error, nowMs: nowMs() });
          if ([401, 403].includes(Number(error?.status))
            || error?.code === "pairing_session_changed"
            || error?.code === "pairing_team_policy_regressed") {
            pulseTokenManager.clearAuthentication();
            throw error;
          }
          // Keep retrying for as long as the Remote would still hold this
          // clone's lease; only a lapsed lease ends the console.
          if (nowMs() - lastHeartbeatOkMs > leaseSec * 1000) throw leaseLapsedError(error, leaseSec, safeError);
          // Git sync does not depend on the relay; keep the checkout current.
          pollTrunk();
          reportSyncTransition(state);
          await waitForNextLap(retryMs);
          continue;
        }
        reportSyncTransition(state);
        if (status.status !== "active") return { reason: status.status, status };
        await waitForNextLap(heartbeatMs);
      }
      // Ctrl+C or a closed terminal detaches a console while posse go owns the
      // session, including while it is still starting and has not adopted yet;
      // it never force-closes a session posse go is running.
      if ((forceRequested || gracefulRequested) && (observing || schedulerLockHolderLive(kill) || goWindowStarting())) {
        detached = true;
        if (!json) log(`  ${C.dim}[session] console detached; posse go keeps the session${C.reset}`);
        return { reason: "scheduler_handoff", detached: true };
      }
      return {
        reason: gracefulRequested ? "graceful_close" : forceRequested ? "force_close" : "local_leave",
      };
    } finally {
      stopping = true;
      // A foreground command (or one queued behind a slow admit) finishes
      // before the prompt closes and before leaving can race it.
      await commandChain.catch(() => {});
      sessionConsole?.close();
      if (consolePoll) {
        consolePoller.abortInFlight?.("The session console is exiting");
        await consolePoll;
      }
      // The scheduler owns the peer snapshot while it runs.
      if (!observing && !detached) clearPairingPeerSnapshot();
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGHUP", hangup);
    }
  }
}
