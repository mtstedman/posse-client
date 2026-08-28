import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  casPushSharedTrunkClaimNative,
  fetchSharedTrunkNative,
  ffUpdateSharedTrunkNative,
  getSharedTrunkNativeCapabilities,
  pushSharedTrunkNative,
  resetRejectedSharedTrunkNative,
} from "../lib/domains/git/functions/shared-trunk-native.js";

function git(cwd, args, { trim = true } = {}) {
  const output = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  return trim ? String(output).trim() : String(output);
}

function nativeResult(envelope, operation) {
  if (envelope?.available === false) {
    const error = new Error(`Shared-trunk smoke requires the native v2 contract (${operation})`);
    error.code = "SHARED_TRUNK_NATIVE_UNAVAILABLE";
    throw error;
  }
  return envelope?.result ?? envelope;
}

function outcome(result) {
  return String(result?.outcome || result?.status || "").trim().toLowerCase();
}

function commitFile(repo, file, contents, message) {
  fs.writeFileSync(path.join(repo, file), contents, "utf8");
  git(repo, ["add", "--", file]);
  git(repo, ["commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function configureClone(repo) {
  git(repo, ["config", "user.name", "Posse Shared Trunk Smoke"]);
  git(repo, ["config", "user.email", "posse-shared-trunk@example.invalid"]);
}

/**
 * Headless two-clone smoke for the native optimistic serializer. The harness
 * never touches the caller's repository or DB; all refs live beneath one
 * mkdtemp root and are removed on exit.
 */
export async function runSharedTrunkSmoke({ onProgress = null } = {}) {
  const progress = typeof onProgress === "function" ? onProgress : () => {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-shared-trunk-smoke-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const cloneA = path.join(root, "instance-a");
  const cloneB = path.join(root, "instance-b");
  const branch = "posse/shared-smoke";
  const remote = "origin";
  try {
    progress("checking native shared-trunk capability");
    nativeResult(await getSharedTrunkNativeCapabilities(process.cwd()), "capability probe");

    fs.mkdirSync(seed, { recursive: true });
    git(root, ["init", "-q", "--bare", origin]);
    git(seed, ["init", "-q", "-b", "main"]);
    configureClone(seed);
    commitFile(seed, "base.txt", "base\n", "seed");
    git(seed, ["switch", "-q", "-c", branch]);
    git(seed, ["remote", "add", remote, origin]);
    git(seed, ["push", "-q", remote, `main:main`, `${branch}:${branch}`]);
    git(root, ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"]);
    git(root, ["clone", "-q", "--branch", branch, origin, cloneA]);
    git(root, ["clone", "-q", "--branch", branch, origin, cloneB]);
    configureClone(cloneA);
    configureClone(cloneB);

    const base = git(cloneA, ["rev-parse", "HEAD"]);
    const candidateA = commitFile(cloneA, "a.txt", "from A\n", "instance A");
    const candidateB = commitFile(cloneB, "b.txt", "from B\n", "instance B");

    progress("publishing the winning candidate");
    const pushedA = nativeResult(await pushSharedTrunkNative({
      cwd: cloneA,
      remote,
      branch,
      expectedRemoteOid: base,
      newOid: candidateA,
    }), "first push");
    if (!new Set(["pushed", "already_published"]).has(outcome(pushedA))) {
      throw new Error(`first smoke push returned ${outcome(pushedA) || "no outcome"}`);
    }

    progress("forcing and recovering one compare-and-swap race");
    const rejectedB = nativeResult(await pushSharedTrunkNative({
      cwd: cloneB,
      remote,
      branch,
      expectedRemoteOid: base,
      newOid: candidateB,
    }), "contended push");
    if (outcome(rejectedB) !== "rejected_nonff") {
      throw new Error(`contended smoke push returned ${outcome(rejectedB) || "no outcome"}`);
    }
    const fetchedB = nativeResult(await fetchSharedTrunkNative({
      cwd: cloneB,
      remote,
      branch,
      includeClaims: false,
    }), "contention fetch");
    const winnerOid = fetchedB.newOid;
    const resetB = nativeResult(await resetRejectedSharedTrunkNative({
      cwd: cloneB,
      remote,
      branch,
      expectedCandidateOid: candidateB,
      remoteOid: winnerOid,
    }), "rejected-candidate reset");
    if (outcome(resetB) !== "reset") {
      throw new Error(`rejected-candidate reset returned ${outcome(resetB) || "no outcome"}`);
    }
    git(cloneB, ["cherry-pick", candidateB]);
    const retriedCandidateB = git(cloneB, ["rev-parse", "HEAD"]);
    const pushedB = nativeResult(await pushSharedTrunkNative({
      cwd: cloneB,
      remote,
      branch,
      expectedRemoteOid: winnerOid,
      newOid: retriedCandidateB,
    }), "retried push");
    if (!new Set(["pushed", "already_published"]).has(outcome(pushedB))) {
      throw new Error(`retried smoke push returned ${outcome(pushedB) || "no outcome"}`);
    }

    progress("round-tripping one advisory claim");
    const claimPath = "src/shared-smoke.js";
    const claimKey = crypto.createHash("sha256").update(`file\0${claimPath}`, "utf8").digest("hex");
    const claimPayload = {
      protocol: "posse.shared_trunk_claim.v1",
      instance_id: "smoke-instance-a",
      wi_id: 1,
      job_id: 1,
      path: claimPath,
      scope_kind: "file",
      kind: "hard",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const claimCreate = nativeResult(await casPushSharedTrunkClaimNative({
      cwd: cloneA,
      remote,
      claimKey,
      expectedOldOid: null,
      payload: claimPayload,
    }), "claim create");
    if (outcome(claimCreate) !== "applied" || !claimCreate.newOid) {
      throw new Error(`claim create returned ${outcome(claimCreate) || "no outcome"}`);
    }
    const fetchedClaims = nativeResult(await fetchSharedTrunkNative({
      cwd: cloneB,
      remote,
      branch,
      includeClaims: true,
    }), "claim fetch");
    if (!fetchedClaims.claims?.some((claim) => claim.claimKey === claimKey)) {
      throw new Error("claim fetch did not return the published claim");
    }
    const claimDelete = nativeResult(await casPushSharedTrunkClaimNative({
      cwd: cloneA,
      remote,
      claimKey,
      expectedOldOid: claimCreate.newOid,
      payload: null,
    }), "claim delete");
    if (outcome(claimDelete) !== "applied") {
      throw new Error(`claim delete returned ${outcome(claimDelete) || "no outcome"}`);
    }

    progress("fast-forwarding the other clone");
    const beforeA = git(cloneA, ["rev-parse", "HEAD"]);
    const fetchedA = nativeResult(await fetchSharedTrunkNative({
      cwd: cloneA,
      remote,
      branch,
      includeClaims: false,
    }), "convergence fetch");
    const ffA = nativeResult(await ffUpdateSharedTrunkNative({
      cwd: cloneA,
      remote,
      branch,
      expectedLocalOid: beforeA,
    }), "convergence ff-update");
    if (!new Set(["advanced", "unchanged"]).has(outcome(ffA))) {
      throw new Error(`convergence ff-update returned ${outcome(ffA) || "no outcome"}`);
    }
    const remoteHead = git(root, ["--git-dir", origin, "rev-parse", `refs/heads/${branch}`]);
    const headA = git(cloneA, ["rev-parse", "HEAD"]);
    const headB = git(cloneB, ["rev-parse", "HEAD"]);
    if (headA !== remoteHead || headB !== remoteHead || fetchedA.newOid !== remoteHead) {
      throw new Error("smoke clones did not converge on the remote side trunk");
    }

    return {
      ok: true,
      branch,
      base,
      firstCandidate: candidateA,
      rejectedCandidate: candidateB,
      retriedCandidate: retriedCandidateB,
      remoteHead,
      pushRejections: 1,
      claimsRoundTripped: 1,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
