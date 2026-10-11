import { sessionFetchOwnerAlive } from "./session-sync.js";
import { formatSyncAge } from "./sync-state.js";
import { diffPairingPeerActivity } from "./work-items.js";
import { sessionMemberLabel, shortId } from "./session-console.js";

export function printPeerActivityChanges(C, status, seen, { json = false, log = console.log } = {}) {
  const changes = diffPairingPeerActivity(status?.peers, seen);
  for (const change of changes) {
    if (json) {
      console.log(JSON.stringify({
        event: "pairing_peer_activity",
        scope: "peer_read_only",
        local_queue: false,
        ...change,
      }));
      continue;
    }
    const verb = change.kind === "spawned" ? "started" : "updated";
    const entity = change.entity_type === "job" ? change.job : change.work_item;
    const entityLabel = change.entity_type === "job"
      ? `job #${entity.id}${entity.work_item_id ? ` (WI#${entity.work_item_id})` : ""} ${entity.job_type}`
      : `WI#${entity.id}`;
    log(
      `  ${C.dim}[pair peer · read-only]${C.reset} ${change.peer.label} ${verb} `
      + `${C.cyan}${entityLabel}${C.reset} `
      + `${entity.status}: ${entity.title}`,
    );
  }
}

export function memberLabel(member) {
  return sessionMemberLabel(member);
}

export function printMemberChanges(log, C, events, { json = false } = {}) {
  for (const event of events) {
    const member = event.member || {};
    if (json) {
      log(JSON.stringify({
        event: "pairing_member",
        kind: event.kind,
        member_id: member.id || null,
        state: member.state || null,
        instance_id: member.instance_id || null,
      }));
      continue;
    }
    if (event.kind === "pending") {
      log(`  ${C.yellow}[session]${C.reset} ${C.bold}Join request${C.reset} from ${memberLabel(member)}. `
        + "Ask them for the 4-character countersign on their screen, type it here and press Enter.");
    } else if (event.kind === "joined") {
      log(`  ${C.green}[session]${C.reset} ${memberLabel(member)} joined`);
    } else {
      log(`  ${C.dim}[session]${C.reset} ${memberLabel(member)} ${member.state === "kicked" ? "was removed" : "left"}`);
    }
  }
}

export function describeSessionHold(hold) {
  const ttlSec = Math.max(0, Math.round((Date.parse(hold?.expires_at) - Date.parse(hold?.set_at)) / 1000));
  let owner = true;
  try {
    owner = sessionFetchOwnerAlive({ stateId: hold?.state_id });
  } catch { /* the hint is advisory */ }
  return `Held this checkout for ${formatSyncAge(ttlSec)}${hold?.reason ? ` (${hold.reason})` : ""}: `
    + "fetches continue, fast-forwards and publications wait. Type resume to lift it."
    + (owner ? "" : " Nothing is syncing this folder right now; the hold applies once the session console or posse go runs.");
}

export function describeSessionResume(result) {
  if (result?.ok && result.resumed) return "Hold lifted; this checkout catches up now.";
  if (result?.reason === "not_held") return "This checkout is not held.";
  if (result?.reason === "no_active_session") return "This clone is not in a live session.";
  return `Resume failed: ${result?.reason || "unknown error"}`;
}

export function printHostConsoleMembers(log, members) {
  if (members.length === 0) {
    log("  No members yet.");
    return;
  }
  for (const member of members) {
    log(`  ${shortId(member.id)}  ${member.state}/${member.role || "member"}  ${shortId(member.instance_id)}`);
  }
}
