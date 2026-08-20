// @ts-check
//
// Portable ATLAS snapshots for pre-warmed repositories. SQLite databases in
// WAL mode are a multi-file storage unit; copying only the `*.db` pathname can
// silently discard committed metadata. VACUUM INTO materializes every
// committed frame into a standalone database file suitable for an archive.

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

import { waitingLaneGenerationsEqual } from "../../../../catalog/waiting-lane.js";
import { runSqliteWrite } from "../../../../shared/concurrency/functions/sqlite-gate.js";
import { Ledger } from "../../classes/v2/Ledger.js";
import { View } from "../../classes/v2/View.js";
import {
  inspectAtlasMainSourceProof,
  withAtlasMainSourceProofLock,
} from "./main-generation.js";
import {
  mainIntakeStatePath,
  readAtlasMainIntakeState,
  writeAtlasMainIntakeSnapshot,
} from "./main-intake-state.js";

function removeSnapshotFile(dbPath) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* only newly-created snapshot files are cleaned */ }
  }
}

function removeSnapshotSidecars(dbPath) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* a standalone snapshot needs only the base file */ }
  }
}

function assertSnapshotDestination(sourcePath, destinationPath) {
  const source = path.resolve(String(sourcePath || ""));
  const destination = path.resolve(String(destinationPath || ""));
  if (!sourcePath || !destinationPath || source === destination) {
    throw new TypeError("ATLAS snapshot source and destination must be distinct paths");
  }
  if (fs.existsSync(destination)
    || fs.existsSync(`${destination}-wal`)
    || fs.existsSync(`${destination}-shm`)
    || fs.existsSync(`${destination}-journal`)) {
    throw new Error(`ATLAS snapshot destination already exists: ${destination}`);
  }
  return destination;
}

function vacuumInto(sourcePath, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const source = new Database(sourcePath, { fileMustExist: true });
  try {
    source.pragma("busy_timeout = 5000");
    source.prepare("VACUUM INTO ?").run(destinationPath);
  } finally {
    source.close();
  }
  const destination = new Database(destinationPath, { fileMustExist: true });
  try {
    destination.pragma("busy_timeout = 5000");
    destination.pragma("journal_mode = WAL");
    const checkpoint = destination.pragma("wal_checkpoint(TRUNCATE)")?.[0];
    if (checkpoint?.busy) throw new Error("ATLAS snapshot destination checkpoint was busy");
  } finally {
    destination.close();
  }
}

function inspectStoredGeneration({ ledgerPath, viewPath, targetBranch, expectedGeneration = null }) {
  const ledger = Ledger.openReadOnly({ dbPath: ledgerPath });
  const view = View.mount({ dbPath: viewPath });
  try {
    const generation = view.generationLocal();
    if (!generation) throw new Error("ATLAS portable snapshot requires a published main generation");
    if (generation.target_branch !== targetBranch) {
      throw new Error("ATLAS portable snapshot target branch does not match the main view");
    }
    if (ledger.headSeq(targetBranch) !== generation.atlas_ledger_seq) {
      throw new Error("ATLAS portable snapshot ledger head does not match the main view");
    }
    if (ledger.layerRevision() !== generation.atlas_layer_revision) {
      throw new Error("ATLAS portable snapshot layer revision does not match the main view");
    }
    if (expectedGeneration && !waitingLaneGenerationsEqual(generation, expectedGeneration)) {
      throw new Error("ATLAS portable snapshot generation changed while materializing");
    }
    return generation;
  } finally {
    view.close();
    ledger.close();
  }
}

/**
 * Create standalone ledger and main-view database files for a pre-warmed
 * archive. The destination files must not already exist.
 *
 * @param {{
 *   repoRoot: string,
 *   targetBranch: string,
 *   ledgerPath: string,
 *   viewPath: string,
 *   destinationLedgerPath: string,
 *   destinationViewPath: string,
 *   destinationRepoRoot: string,
 *   signal?: AbortSignal | null,
 *   lockWaitMs?: number,
 * }} args
 */
export async function createAtlasPortableSnapshot({
  repoRoot,
  targetBranch,
  ledgerPath,
  viewPath,
  destinationLedgerPath,
  destinationViewPath,
  destinationRepoRoot,
  signal = null,
  lockWaitMs = 30_000,
}) {
  if (!destinationRepoRoot) {
    throw new TypeError("ATLAS portable snapshot destinationRepoRoot is required");
  }
  const outLedger = assertSnapshotDestination(ledgerPath, destinationLedgerPath);
  const outView = assertSnapshotDestination(viewPath, destinationViewPath);
  const outIntakeState = mainIntakeStatePath(destinationRepoRoot);
  if (fs.existsSync(outIntakeState)) {
    throw new Error(`ATLAS snapshot destination already exists: ${outIntakeState}`);
  }
  let intakeStateCreated = false;
  try {
    return await withAtlasMainSourceProofLock({
      repoRoot,
      targetBranch,
      signal,
      lockWaitMs,
      run: async (sourceProof) => {
        if (!sourceProof?.ok) {
          throw new Error(`ATLAS portable snapshot source proof failed: ${sourceProof?.reason || "unavailable"}`);
        }
        return runSqliteWrite(ledgerPath, () => runSqliteWrite(viewPath, async () => {
          const sourceGeneration = inspectStoredGeneration({
            ledgerPath,
            viewPath,
            targetBranch,
          });
          if (sourceGeneration.git_oid !== sourceProof.git_oid) {
            throw new Error("ATLAS portable snapshot Git generation does not match the checkout");
          }
          const recordedIntake = readAtlasMainIntakeState(repoRoot);
          if (recordedIntake && recordedIntake.status !== "complete") {
            throw new Error(`ATLAS portable snapshot intake is not complete (${recordedIntake.status})`);
          }
          if (recordedIntake?.generation
            && !waitingLaneGenerationsEqual(recordedIntake.generation, sourceGeneration)) {
            throw new Error("ATLAS portable snapshot intake generation does not match the main view");
          }
          vacuumInto(ledgerPath, outLedger);
          vacuumInto(viewPath, outView);
          const storedGeneration = inspectStoredGeneration({
            ledgerPath: outLedger,
            viewPath: outView,
            targetBranch,
            expectedGeneration: sourceGeneration,
          });
          const after = await inspectAtlasMainSourceProof({
            repoRoot,
            targetBranch,
            expectedGitOid: sourceProof.git_oid,
            signal,
          });
          if (!after?.ok) {
            throw new Error(`ATLAS portable snapshot post-proof failed: ${after?.reason || "unavailable"}`);
          }
          const intakeState = recordedIntake || {
            schema_version: 1,
            attempt_id: `legacy-${sourceGeneration.git_oid}`,
            status: "complete",
            purpose: "legacy-prewarm-snapshot",
            target_branch: sourceGeneration.target_branch,
            git_oid: sourceGeneration.git_oid,
            source_proof: { ok: true, reason: null },
            started_at: null,
            last_started_at: null,
            finished_at: new Date().toISOString(),
            resume_count: 0,
            resumed_from_status: null,
            scope: { kind: "repository", path_count: 0, paths: [], paths_truncated: false },
            generation: sourceGeneration,
            result: null,
            error: null,
            supersedes_attempt_id: null,
          };
          writeAtlasMainIntakeSnapshot(destinationRepoRoot, intakeState);
          intakeStateCreated = true;
          removeSnapshotSidecars(outLedger);
          removeSnapshotSidecars(outView);
          return {
            ok: true,
            ledgerPath: outLedger,
            viewPath: outView,
            intakeStatePath: outIntakeState,
            generation: storedGeneration,
          };
        }, {
          label: "ATLAS portable snapshot main view",
          waitMs: lockWaitMs,
        }), {
          label: "ATLAS portable snapshot ledger",
          waitMs: lockWaitMs,
        });
      },
    });
  } catch (err) {
    removeSnapshotFile(outLedger);
    removeSnapshotFile(outView);
    if (intakeStateCreated) {
      try { fs.unlinkSync(outIntakeState); } catch { /* no snapshot state was committed */ }
    }
    throw err;
  }
}
