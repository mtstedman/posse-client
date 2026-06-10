import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

function gitValue(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function gitOk(cwd, args) {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function stripRemotePrefix(refName) {
  const ref = String(refName || "").trim();
  const slash = ref.indexOf("/");
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}

function localBranchExists(projectDir, branchName) {
  const branch = String(branchName || "").trim();
  if (!branch) return false;
  return gitOk(projectDir, ["rev-parse", "--verify", `refs/heads/${branch}`]);
}

function remoteBranchExists(projectDir, branchName) {
  const branch = String(branchName || "").trim();
  if (!branch) return false;
  return gitValue(projectDir, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"])
    .split(/\r?\n/)
    .map((ref) => stripRemotePrefix(ref))
    .some((ref) => ref === branch);
}

function gitRepoAvailable(projectDir) {
  return gitOk(projectDir, ["rev-parse", "--git-dir"]);
}

function currentLocalBranch(projectDir) {
  const branch = gitValue(projectDir, ["branch", "--show-current"]);
  if (!branch || branch === "HEAD") return "";
  return localBranchExists(projectDir, branch) ? branch : "";
}

function localBranches(projectDir) {
  return gitValue(projectDir, ["branch", "--format=%(refname:short)"])
    .split(/\r?\n/)
    .map((branch) => branch.trim())
    .filter(Boolean);
}

function isWiBranch(branch) {
  const rest = String(branch || "").startsWith("wi-")
    ? String(branch).slice(3)
    : "";
  if (!rest) return false;
  const digits = rest.match(/^\d+/)?.[0] || "";
  if (!digits) return false;
  const next = rest.slice(digits.length, digits.length + 1);
  return !next || next === "-" || next === "_" || next === "/";
}

function isWorkItemBranch(branchName, knownBranches) {
  const branch = String(branchName || "").trim();
  return branch.startsWith("posse/") || isWiBranch(branch) || knownBranches.has(branch);
}

function currentUpstreamLocalBranch(projectDir, knownBranches) {
  const upstream = gitValue(projectDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const branch = stripRemotePrefix(upstream);
  return branch && !isWorkItemBranch(branch, knownBranches) && localBranchExists(projectDir, branch)
    ? branch
    : "";
}

function remoteDefaultLocalBranch(projectDir, knownBranches) {
  const remoteHead = gitValue(projectDir, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const branch = stripRemotePrefix(remoteHead);
  return branch && !isWorkItemBranch(branch, knownBranches) && localBranchExists(projectDir, branch)
    ? branch
    : "";
}

function resolveTargetBranchPayload(payload) {
  const projectDir = String(payload?.projectDir || "");
  const configuredTarget = String(payload?.configuredTarget || "").trim();
  const knownBranches = new Set(
    Array.isArray(payload?.knownWorkItemBranches)
      ? payload.knownWorkItemBranches.map((branch) => String(branch || "").trim()).filter(Boolean)
      : [],
  );
  const warnings = [];

  if (configuredTarget) {
    if (localBranchExists(projectDir, configuredTarget)) {
      return { branch: configuredTarget, source: "configured-local", configuredRemoteExists: false, warnings };
    }
    const configuredRemoteExists = remoteBranchExists(projectDir, configuredTarget);
    if (!gitRepoAvailable(projectDir)) {
      return {
        branch: configuredTarget,
        source: "configured-repo-unavailable",
        configuredRemoteExists,
        warnings,
      };
    }
    if (!configuredRemoteExists) {
      warnings.push(`Configured target_branch '${configuredTarget}' was not found locally or on a remote; falling back to branch detection.`);
    }
  }

  const current = currentLocalBranch(projectDir);
  if (current && !isWorkItemBranch(current, knownBranches)) {
    return { branch: current, source: "current", configuredRemoteExists: false, warnings };
  }

  const upstream = currentUpstreamLocalBranch(projectDir, knownBranches);
  if (upstream) return { branch: upstream, source: "upstream", configuredRemoteExists: false, warnings };

  const remoteDefault = remoteDefaultLocalBranch(projectDir, knownBranches);
  if (remoteDefault) return { branch: remoteDefault, source: "remote-default", configuredRemoteExists: false, warnings };

  const nonWorkItem = localBranches(projectDir).filter((branch) => !isWorkItemBranch(branch, knownBranches));
  if (nonWorkItem.length === 1) {
    return {
      branch: nonWorkItem[0],
      source: "only-non-work-item",
      configuredRemoteExists: false,
      warnings,
    };
  }

  const hasMain = localBranchExists(projectDir, "main");
  const hasMaster = localBranchExists(projectDir, "master");
  if (hasMain && hasMaster) warnings.push("Both 'main' and 'master' exist - using 'main'.");
  if (hasMain) return { branch: "main", source: "main", configuredRemoteExists: false, warnings };
  if (hasMaster) return { branch: "master", source: "master", configuredRemoteExists: false, warnings };
  return { branch: "main", source: "default-main", configuredRemoteExists: false, warnings };
}

export function targetBranchNativeParity() {
  return {
    manager: {
      shouldUse(name) {
        assert.equal(name, "git");
        return true;
      },
      binary(name) {
        assert.equal(name, "git");
        return {
          runSync(command, args, opts) {
            assert.equal(command, "git.resolveTargetBranch");
            assert.deepEqual(args, []);
            const envelope = JSON.parse(String(opts.input));
            const json = { ok: true, data: resolveTargetBranchPayload(envelope.payload) };
            return { ok: true, code: 0, stdout: JSON.stringify(json), stderr: "", error: null, json };
          },
        };
      },
    },
  };
}
