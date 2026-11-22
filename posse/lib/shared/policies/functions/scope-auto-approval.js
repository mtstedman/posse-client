import { DEV_ROLE_JOB_TYPES } from "../../../catalog/job.js";
// Deterministic auto-approval policy for mechanical scope-expansion requests.
//
// request_scope parks the requesting job behind a human gate. For path
// classes that carry no meaningful repo-intent decision the gate is pure
// friction: the human always approves, and each request costs a full
// pause → prompt → answer → re-run cycle. This table names the classes a
// scope request may be granted without a human:
//
//  - create_root_covered: the path sits inside a create_root the planner
//    already approved for this job. The mutation predicates accept such
//    paths anyway; agents still pre-ask via request_scope.
//  - test_path: additive test collateral for dev/fix jobs. Assessment
//    policy demands tests while plans chronically under-enumerate test
//    files; the diff still goes through assessment. Only files in a test
//    directory, or source files named by a test-runner convention, count
//    (isRoutineTestScopePath): CI, deploy and executable script paths that
//    merely look like tests still need a human.
//  - generated_file: lockfiles and generated snapshots that follow
//    mechanically from an in-scope change.
//  - project_manifest: package/build manifests and ignore rules for dev/fix
//    jobs. Adding a dependency, script, or compiler option is ordinary
//    development; installing still needs its own approval, and the write
//    lock guard still keeps another work item's edits out.
//
// Everything else still routes to the human gate. The operator can disable
// the whole tier with the `scope_auto_approval` setting.

const GENERATED_BASENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "cargo.lock",
  "poetry.lock",
  "uv.lock",
  "pipfile.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
]);

const PROJECT_MANIFEST_BASENAMES = new Set([
  "package.json",
  "composer.json",
  ".gitignore",
  "pyproject.toml",
  "requirements.txt",
  "requirements-dev.txt",
  "dev-requirements.txt",
  "cargo.toml",
  "go.mod",
  "gemfile",
]);
const PROJECT_MANIFEST_RE = /^(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json$/i;

const WRITABLE_TEST_DIRECTORY_RE = /(?:^|\/)(?:tests?|__tests__|__snapshots__|specs?|testdata)\//i;
const TEST_SEGMENT_RE = /(?:^|\/)(?:tests?|__tests__|__snapshots__|specs?|testdata|fixtures)\//i;
const TEST_FILENAME_RE = /(?:^|\/)(?:test_[^/]+|conftest\.py|[^/]+(?:\.test|\.spec|_test|_spec|-test|-spec)\.[a-z0-9]+)$/i;
const SNAPSHOT_RE = /\.snap$/i;

// Routine (human-free) test approval is narrower than test collateral, which
// materialization and test ownership still use. Outside a test directory only
// the colocated naming conventions of test runners count (Jest/Vitest/Mocha
// `.test`/`.spec`, Go `_test`, RSpec `_spec`, pytest conftest.py), and only on
// source files a runner loads, so `Makefile.spec.in` or `test_release.sh` is
// not a test. Never routine: CI and deploy directories, whose files run with
// pipeline or production credentials, and executable scripts, which run
// directly wherever they sit.
const COLOCATED_TEST_FILENAME_RE = /(?:^|\/)(?:conftest\.py|[^/]+(?:\.test|\.spec|_test|_spec)\.(?:[cm]?[jt]sx?|py|go|rb|rs|php|java|kts?|scala|cs|fs|swift|dart|exs?|lua|c|cc|cpp|h|hpp))$/i;
const NON_ROUTINE_TEST_DIRECTORY_RE = /(?:^|\/)(?:\.github|\.gitea|\.forgejo|\.gitlab|\.circleci|\.buildkite|\.azure-pipelines|\.woodpecker|\.?ci|deploy|deploys|deployment|deployments)\//i;
const EXECUTABLE_SCRIPT_EXTENSION_RE = /\.(?:sh|bash|zsh|ksh|csh|tcsh|fish|command|ps1|psm1|bat|cmd|vbs|exe)$/i;

const TEST_ELIGIBLE_JOB_TYPES = DEV_ROLE_JOB_TYPES;

function normalizeScopePath(value) {
  return String(value || "").replace(/\\/g, "/").trim().replace(/^\.\//, "");
}

function isUnderRoot(relPath, root) {
  const normalizedRoot = normalizeScopePath(root).replace(/\/+$/, "");
  if (!normalizedRoot || normalizedRoot === "." || normalizedRoot === "/") return false;
  return relPath === normalizedRoot || relPath.startsWith(`${normalizedRoot}/`);
}

// write_tests is authority for test directories, including helpers/fixtures
// beneath them. A test-like basename beside production code is not a folder
// grant; it still follows the configured routine-expansion policy.
export function isTestDirectoryPath(relPath) {
  return WRITABLE_TEST_DIRECTORY_RE.test(normalizeScopePath(relPath));
}

export function isTestCollateralPath(relPath) {
  const normalized = normalizeScopePath(relPath);
  if (!normalized) return false;
  return TEST_SEGMENT_RE.test(normalized)
    || TEST_FILENAME_RE.test(normalized)
    || SNAPSHOT_RE.test(normalized);
}

export function isRoutineTestScopePath(relPath) {
  const normalized = normalizeScopePath(relPath);
  if (!normalized) return false;
  if (NON_ROUTINE_TEST_DIRECTORY_RE.test(normalized) || EXECUTABLE_SCRIPT_EXTENSION_RE.test(normalized)) return false;
  return isTestDirectoryPath(normalized)
    || COLOCATED_TEST_FILENAME_RE.test(normalized)
    || SNAPSHOT_RE.test(normalized);
}

export function isProjectManifestPath(relPath) {
  const base = normalizeScopePath(relPath).split("/").filter(Boolean).at(-1) || "";
  return PROJECT_MANIFEST_BASENAMES.has(base.toLowerCase()) || PROJECT_MANIFEST_RE.test(base);
}

export function isGeneratedScopePath(relPath) {
  const normalized = normalizeScopePath(relPath);
  if (!normalized) return false;
  const base = normalized.split("/").filter(Boolean).at(-1) || "";
  return GENERATED_BASENAMES.has(base.toLowerCase());
}

/**
 * Classify a scope-expansion request against the auto-approval table.
 * Returns { reason } naming the matched class, or null when the request
 * needs a human decision.
 */
export function classifyAutoApprovableScopeRequest({
  path,
  jobType = "",
  createRoots = [],
} = {}) {
  const relPath = normalizeScopePath(path);
  if (!relPath) return null;

  const roots = Array.isArray(createRoots) ? createRoots : [];
  if (roots.some((root) => isUnderRoot(relPath, root))) {
    return { reason: "create_root_covered" };
  }

  if (!TEST_ELIGIBLE_JOB_TYPES.has(String(jobType || "").trim())) return null;

  if (isRoutineTestScopePath(relPath)) {
    return { reason: "test_path" };
  }
  if (isGeneratedScopePath(relPath)) {
    return { reason: "generated_file" };
  }
  if (isProjectManifestPath(relPath)) {
    return { reason: "project_manifest" };
  }
  return null;
}
