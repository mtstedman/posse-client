// One decision for every remote route: the host issues each participant's
// lease, and the lease names who runs and pays for that participant's routable
// work. A phone paired with `posse serve` holds a host lease. A clone joined
// with `posse session join` holds the lease the host issued at admission, or
// the session policy's default. Routing, executor acceptance, attribution and
// the CLI all resolve ownership here, so a later load balancer has one input.

import {
  SESSION_COMPUTE_OWNERS,
  SESSION_COMPUTE_OWNER_VALUES,
  SESSION_COMPUTE_POLICIES,
  defaultSessionComputeOwner,
} from "../../../catalog/session-sync.js";

const HOST = SESSION_COMPUTE_OWNERS.HOST;

/** A known lease owner, or null for anything else. */
export function normalizeComputeOwner(value) {
  return SESSION_COMPUTE_OWNER_VALUES.includes(value) ? value : null;
}

/**
 * Who runs this clone's own routable work. The host always runs its own; a
 * member follows the lease the Remote reported, else the session default.
 */
export function ownComputeOwner(state) {
  if (!state) return null;
  if (state.role === "host") return HOST;
  return normalizeComputeOwner(state.compute_owner) || defaultSessionComputeOwner(state.compute_policy);
}

/** Who runs a peer's routable work, as the issuer's Remote reports it. */
export function peerComputeOwner(peer, computePolicy) {
  if (!peer) return null;
  if (peer.role === "host") return HOST;
  return normalizeComputeOwner(peer.compute_owner) || defaultSessionComputeOwner(computePolicy);
}

/**
 * Whether this clone takes part in session routing at all: as an originator
 * whose lease sends work to the host, as the host for at least one such lease,
 * or because the host turned on capability routing for everyone.
 */
export function sessionRoutingActive(state, peers = []) {
  if (!state || state.phase !== "active") return false;
  if (state.compute_policy && state.compute_policy !== SESSION_COMPUTE_POLICIES.EACH_MEMBER) return true;
  if (state.role !== "host") return ownComputeOwner(state) === HOST;
  return (Array.isArray(peers) ? peers : [])
    .some((peer) => peerComputeOwner(peer, state.compute_policy) === HOST);
}

/**
 * Whether this clone should claim work `originator` offered. The issuer's
 * lease decides who pays. The host runs work for members whose lease names
 * the host; under capability routing it also balances anyone's overflow and
 * pays for what it runs. A member balances only under capability routing,
 * only while paying its own way, and never for work leased to the host: a
 * host-leased member would otherwise pass the work on to the host's bill.
 */
export function acceptsSessionOffer(state, originator) {
  if (!state || state.phase !== "active" || !originator) return false;
  // The host always runs its own work; nobody claims from the issuer.
  if (originator.role === "host") return false;
  const originatorOwner = peerComputeOwner(originator, state.compute_policy);
  const balancing = state.compute_policy === SESSION_COMPUTE_POLICIES.CAPABILITY_ROUTING;
  if (state.role === "host") return originatorOwner === HOST || balancing;
  return balancing
    && ownComputeOwner(state) === SESSION_COMPUTE_OWNERS.MEMBER
    && originatorOwner === SESSION_COMPUTE_OWNERS.MEMBER;
}

/**
 * Whether this clone may offer its routable work to `candidate`. This is the
 * candidate's own `acceptsSessionOffer` answered from the originator's side,
 * so an offer is only ever made to a peer that would claim it: the host
 * offers to nobody, a host-leased member offers to the host alone, and a
 * member paying its own way balances only with the host and with members who
 * also pay their own way (capability routing).
 */
export function offersSessionWorkTo(state, candidate) {
  if (!state || state.phase !== "active" || !candidate) return false;
  return acceptsSessionOffer(
    {
      phase: "active",
      role: candidate.role,
      compute_policy: state.compute_policy,
      compute_owner: candidate.compute_owner,
    },
    { role: state.role, compute_owner: ownComputeOwner(state) },
  );
}

/**
 * The lease an executor records when it imports offered work: HOST when the
 * originator's lease named the issuer, MEMBER when capability routing moved it.
 */
export function acceptedComputeOwner(state, originator) {
  return state?.role === "host" && peerComputeOwner(originator, state?.compute_policy) === HOST
    ? HOST
    : SESSION_COMPUTE_OWNERS.MEMBER;
}

/** One line a person can read: who runs and pays for the lease holder's work. */
export function describeComputeOwner(owner, { holder = "member" } = {}) {
  if (owner === HOST) {
    return holder === "self"
      ? "the host's computer runs your work, on the host's provider account"
      : "the host's computer runs their work, on the host's provider account";
  }
  return holder === "self"
    ? "this computer runs your work, on your provider account"
    : "their computer runs their work, on their provider account";
}

/**
 * Who runs work that a phone paired with `posse serve` queues on this clone.
 * A phone's lease always names the computer it is paired to (a phone cannot
 * run work), and that computer's own lease then applies: on its own or as a
 * session host it runs the work itself; as a member on a host lease the work
 * goes on to the session host, like any other work from this clone.
 */
export function servedDeviceComputeOwner(state) {
  return state?.phase === "active" && state.role !== "host" && ownComputeOwner(state) === HOST
    ? "session-host"
    : "self";
}

export function describeServedDeviceCompute(state) {
  return servedDeviceComputeOwner(state) === "session-host"
    ? "work queued from a paired phone follows this clone's session lease: the session host's computer runs it, on the host's provider account"
    : "work queued from a paired phone runs on this computer, on this computer's provider account";
}
