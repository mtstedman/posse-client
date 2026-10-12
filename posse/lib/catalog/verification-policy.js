// @ts-check
import { readonlySet } from "./readonly-collections.js";



export const VERIFICATION_POLICY_SCHEMA_VERSION = 1;

export const DEFAULT_VERIFICATION_WALL_TIMEOUT_MS = 120_000;

export const DEFAULT_VERIFICATION_WALL_TIMEOUT_MAX_MS = 1_800_000;

export const MIN_VERIFICATION_TIMEOUT_MS = 1_000;

export const VERIFICATION_CHECK_CLASSES = Object.freeze(["frozen_test", "canonical_verify", "hook_verify"]);

export const VERIFICATION_IDENTITY_FILES = readonlySet([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "composer.json", "composer.lock",
  "requirements.txt", "requirements.lock", "poetry.lock", "uv.lock", "pdm.lock", "pyproject.toml",
  "go.mod", "go.sum", "Cargo.toml", "Cargo.lock",
  "Gemfile", "Gemfile.lock", "pom.xml", "gradle.lockfile", "packages.lock.json",
  "posse.verification.json",
]);

export const VERIFICATION_IDENTITY_SKIP_DIRS = readonlySet([
  ".git", ".hg", ".svn", ".posse", ".posse-worktrees", "node_modules", "vendor", "target", "dist", "build", "coverage", "__pycache__",
]);
