// doctor/update bootstrap that runs before orchestrator-app opens SQLite.
// Windows cannot replace a loaded native addon, so Posse's own npm repair must
// happen in a process that has never constructed a better-sqlite3 Database.

import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const POSSE_ROOT = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const SETTINGS_PROBE = fileURLToPath(new URL("./maintenance-settings-probe.js", import.meta.url));
const NODE_REPAIR = fileURLToPath(new URL("./maintenance-node-repair.js", import.meta.url));

function hasArg(argv, flag) {
  return argv.includes(flag);
}

function maintenanceFailure(entry) {
  const message = entry?.message || "Posse npm dependency repair failed";
  return {
    ok: false,
    status: "failed",
    project_dir: process.cwd(),
    dry_run: false,
    counts: { checked: 1, installed: 0, dry_run: 0, failed: 1, ready: 0 },
    node: [entry],
    python: [],
    composer: [],
    native: [],
    models: [],
    scip: { ok: false, skipped: "posse npm unavailable", results: [] },
    test_tools: {},
    doctor: {
      ok: false,
      mode: "repair",
      summary: `1 failed: posse npm: ${message}`,
      checked: 1,
      repaired: [],
      pending: [],
      failed: [{ ...entry, label: "posse npm", message }],
      ready: [],
    },
  };
}

function readMaintenanceSettings(projectDir) {
  const env = {
    ...process.env,
    POSSE_PROJECT_DIR: path.resolve(projectDir || process.cwd()),
  };
  const probe = spawnSync(process.execPath, [SETTINGS_PROBE], {
    // The orchestrator DB (scheduler_locks) anchors at process cwd, not
    // POSSE_PROJECT_DIR — probe from the project or the live-scheduler guard
    // reads the checkout's empty DB and never blocks `posse update`.
    cwd: path.resolve(projectDir || process.cwd()),
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (probe.status !== 0) {
    return {
      ok: false,
      error: String(probe.stderr || probe.error?.message || `settings probe exited ${probe.status}`).trim(),
      scheduler_block: null,
      atlas_config: { enabled: false, scipMode: "off", scipLanguages: [] },
    };
  }
  try {
    return JSON.parse(String(probe.stdout || "").trim());
  } catch (error) {
    return {
      ok: false,
      error: `settings probe returned invalid JSON: ${error?.message || error}`,
      scheduler_block: null,
      atlas_config: { enabled: false, scipMode: "off", scipLanguages: [] },
    };
  }
}

function runDoctorInFreshProcess({ projectDir, dryRun, adoptNodeInstall = false }) {
  const args = [path.join(POSSE_ROOT, "orchestrator.js"), "doctor", "--json"];
  if (dryRun) args.push("--dry-run");
  if (adoptNodeInstall) args.push("--adopt-node-install");
  const child = spawnSync(process.execPath, args, {
    cwd: path.resolve(projectDir || process.cwd()),
    env: {
      ...process.env,
      POSSE_PROJECT_DIR: path.resolve(projectDir || process.cwd()),
      // The parent just repaired the Posse npm tree; the child's bootstrap
      // does not need a third pass.
      POSSE_MAINTENANCE_NODE_REPAIRED: "1",
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 3 * 60 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  try {
    return JSON.parse(String(child.stdout || "").trim());
  } catch (error) {
    const detail = String(child.stderr || child.error?.message || child.stdout || "").trim();
    return maintenanceFailure({
      ok: false,
      status: "failed",
      label: "dependency doctor",
      message: detail || `fresh doctor exited ${child.status}: ${error?.message || error}`,
    });
  }
}

async function repairOwnNodeTree({ argv, dryRun, json }) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [NODE_REPAIR], {
      cwd: POSSE_ROOT,
      env: {
        ...process.env,
        POSSE_MAINTENANCE_DRY_RUN: dryRun ? "1" : "0",
        POSSE_MAINTENANCE_ADOPT_NODE: hasArg(argv, "--adopt-node-install") ? "1" : "0",
        POSSE_MAINTENANCE_JSON: json ? "1" : "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-4 * 1024 * 1024); });
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-64 * 1024);
      if (!json) process.stderr.write(chunk);
    });
    child.on("error", (error) => resolve({
      ok: false,
      status: "failed",
      label: "posse npm",
      message: error?.message || String(error),
    }));
    child.on("close", (status) => {
      try {
        const parsed = JSON.parse(stdout.trim());
        if (status !== 0 && parsed?.ok !== false) {
          parsed.ok = false;
          parsed.status = "failed";
        }
        resolve(parsed);
      } catch (error) {
        resolve({
          ok: false,
          status: "failed",
          label: "posse npm",
          message: stderr.trim() || `npm repair worker exited ${status}: ${error?.message || error}`,
        });
      }
    });
  });
}

async function runDoctorBootstrap(argv) {
  const { cmdDoctor } = await import("./doctor-command.js");
  if (hasArg(argv, "--help") || hasArg(argv, "-h")) {
    await cmdDoctor({ argv });
    return;
  }

  const json = hasArg(argv, "--json");
  const dryRun = hasArg(argv, "--dry-run");
  const ownNode = process.env.POSSE_MAINTENANCE_NODE_REPAIRED === "1"
    ? { ok: true, status: "ok", label: "posse npm", message: "repaired by the maintenance parent" }
    : await repairOwnNodeTree({ argv, dryRun, json });
  if (ownNode?.ok === false) {
    await cmdDoctor({
      argv,
      runDoctor: async () => maintenanceFailure(ownNode),
      getAtlasConfig: () => ({ enabled: false, scipMode: "off", scipLanguages: [] }),
    });
    return;
  }

  const settings = readMaintenanceSettings(process.cwd());
  if (!settings.ok && !json) {
    console.warn(`  [bootstrap] settings probe unavailable; SCIP defaults to off: ${settings.error}`);
  }
  await cmdDoctor({
    argv,
    getAtlasConfig: () => settings.atlas_config,
  });
}

async function runUpdateBootstrap(argv) {
  const { cmdUpdate } = await import("./update-command.js");
  if (hasArg(argv, "--help") || hasArg(argv, "-h")) {
    await cmdUpdate({ argv });
    return;
  }

  const json = hasArg(argv, "--json");
  const dryRun = hasArg(argv, "--dry-run");
  const ownNode = await repairOwnNodeTree({ argv, dryRun, json });
  if (ownNode?.ok === false) {
    if (json) console.log(JSON.stringify(maintenanceFailure(ownNode), null, 2));
    else console.error(`\n  Posse update cannot start: ${ownNode.message || "npm dependency repair failed"}\n`);
    process.exitCode = 1;
    return;
  }

  const settings = readMaintenanceSettings(process.cwd());
  if (!settings.ok && !json) {
    console.warn(`  [bootstrap] settings probe unavailable; SCIP defaults to off: ${settings.error}`);
  }
  await cmdUpdate({
    argv,
    posseRoot: POSSE_ROOT,
    getSchedulerBlockMessage: () => settings.scheduler_block,
    getAtlasConfig: () => settings.atlas_config,
    // Git may have replaced package.json and the maintenance implementation.
    // Repair Posse's Node tree in this addon-free parent, then run every other
    // doctor phase from the newly checked-out code in a fresh process.
    runDoctor: async (input = {}) => {
      const refreshedNode = await repairOwnNodeTree({ argv, dryRun: input.dryRun === true, json: true });
      if (refreshedNode?.ok === false) return maintenanceFailure(refreshedNode);
      return runDoctorInFreshProcess({
        projectDir: input.projectDir || process.cwd(),
        dryRun: input.dryRun === true,
        adoptNodeInstall: hasArg(argv, "--adopt-node-install"),
      });
    },
  });
}

export async function runMaintenanceCliIfRequested(argv = process.argv.slice(2)) {
  const command = String(argv[0] || "").trim().toLowerCase();
  if (command === "doctor") {
    await runDoctorBootstrap(argv.slice(1));
    return true;
  }
  if (command === "update") {
    await runUpdateBootstrap(argv.slice(1));
    return true;
  }
  return false;
}
