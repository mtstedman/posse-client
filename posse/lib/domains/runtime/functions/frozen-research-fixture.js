import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { adminGitExec } from "../../git/functions/admin-git-exec.js";
import {
  FROZEN_RESEARCH_FIXTURE_VERSION, FROZEN_RESEARCH_FIXTURE_ENV,
  FROZEN_RESEARCH_FIXTURE_HASH_ENV, FROZEN_RESEARCH_REQUIRED_FILES,
} from "../../../catalog/research-fixture.js";

export function frozenResearchFixtureEnabled(env = process.env) {
  return Boolean(env[FROZEN_RESEARCH_FIXTURE_ENV] || env[FROZEN_RESEARCH_FIXTURE_HASH_ENV]);
}

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (let size; (size = fs.readSync(fd, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, size));
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

// No repair or fallback: a broken fixture must fail before a provider runs.
export function verifyFrozenResearchFixture({ cwd = process.cwd(), env = process.env } = {}) {
  if (!frozenResearchFixtureEnabled(env)) return null;
  const file = env[FROZEN_RESEARCH_FIXTURE_ENV];
  const expectedHash = env[FROZEN_RESEARCH_FIXTURE_HASH_ENV];
  assert(file && /^[a-f0-9]{64}$/.test(expectedHash || ""), "Frozen research requires a sealed fixture manifest");
  assert.equal(hashFile(file), expectedHash, "Frozen research manifest changed");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(manifest.schemaVersion, FROZEN_RESEARCH_FIXTURE_VERSION);
  const root = fs.realpathSync(cwd);
  assert.equal(root, manifest.repoRoot, "Frozen research fixture belongs to another repository");
  // Fixture seals are checked before native authentication is available.
  const git = (...args) => String(adminGitExec(args, root));
  assert.equal(git("rev-parse", "HEAD"), manifest.sourcePin.commit, "Frozen source HEAD changed");
  assert.equal(git("rev-parse", "HEAD^{tree}"), manifest.sourcePin.tree, "Frozen source tree changed");
  assert.equal(git("status", "--porcelain", "--untracked-files=all"), "", "Frozen research source is dirty");
  assert(Array.isArray(manifest.files), "Frozen index file manifest is missing");
  for (const name of FROZEN_RESEARCH_REQUIRED_FILES) assert(manifest.files.some((entry) => entry.path === name), `Frozen index must seal ${name}`);
  const atlas = path.join(root, ".posse/atlas");
  for (const entry of manifest.files) {
    assert(typeof entry.path === "string" && entry.path && !path.isAbsolute(entry.path)
      && !entry.path.split(/[\\/]/).includes(".."), "Invalid frozen index path");
    const target = path.join(atlas, entry.path);
    assert.equal(fs.realpathSync(target), target, `Frozen index link: ${entry.path}`);
    assert.equal(hashFile(target), entry.sha256, `Frozen index changed: ${entry.path}`);
    if (entry.path.endsWith(".db")) {
      const wal = `${target}-wal`;
      assert(!fs.existsSync(wal) || fs.statSync(wal).size === 0, `Frozen index has uncheckpointed writes: ${entry.path}`);
    }
  }
  const intake = JSON.parse(fs.readFileSync(path.join(atlas, "intake/main.json"), "utf8"));
  assert.equal(intake.status, "complete", "Frozen index intake is incomplete");
  assert.equal(intake.git_oid, manifest.sourcePin.commit);
  assert.equal(intake.generation?.git_oid, manifest.sourcePin.commit);
  assert.equal(intake.source_proof?.ok, true, "Frozen index lacks clean source proof");
  return { ...manifest, generation: intake.generation };
}

export function assertFrozenResearchJob(job) {
  assert.equal(job?.job_type, "research", "Frozen fixture mode only permits research jobs");
}
