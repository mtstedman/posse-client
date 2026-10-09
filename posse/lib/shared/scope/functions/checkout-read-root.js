import fs from "node:fs";
import path from "node:path";

import { realpathExistingPrefix } from "../../../domains/runtime/functions/fs-safety.js";

// Entries a checkout read root never exposes: git metadata, Posse runtime
// state, sibling work-item worktrees and the other private workspace dirs the
// toolkit already blocks inside a cwd. `.env*` files are matched separately.
const EXCLUDED_CHECKOUT_PARTS = new Set([".git", ".posse", ".posse-worktrees", ".posse-test-suites", ".claude", ".codex"]);

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The work item's own checkout, which the runtime grants an artificer as one
 * read-only root so it can match existing art, styles and markup: the
 * `.posse-worktrees/wi-N` worktree when it exists, otherwise the project root.
 */
export function workItemCheckoutReadRoot(projectRoot, workItemId) {
  const root = path.resolve(projectRoot);
  if (workItemId == null || String(workItemId).trim() === "") return root;
  const worktree = path.join(root, ".posse-worktrees", `wi-${String(workItemId).trim()}`);
  return fs.existsSync(path.join(worktree, ".git")) ? worktree : root;
}

/**
 * Whether an absolute read root is a checkout read root for `cwd`: an actual
 * checkout (it has `.git`, or is a Posse project root holding `.posse`) that
 * is the project containing `cwd`, or a `.posse-worktrees/<name>` checkout of
 * that project. A planner-named directory such as `htdocs` or `.posse` never
 * qualifies, so it keeps its existing treatment.
 */
export function isCheckoutReadRootFor(root, cwd) {
  if (typeof root !== "string" || !path.isAbsolute(root)) return false;
  const resolved = path.resolve(root);
  const parent = path.dirname(resolved);
  const project = path.basename(parent) === ".posse-worktrees" ? path.dirname(parent) : resolved;
  if (!isInside(project, path.resolve(cwd))) return false;
  return fs.existsSync(path.join(resolved, ".git")) || isDirectory(path.join(resolved, ".posse"));
}

/** The lexical and symlink-resolved spellings a target may be judged against. */
export function checkoutReadRootForms(root) {
  return [...new Set([path.resolve(root), realpathExistingPrefix(root)])];
}

/**
 * Whether `target` is readable under one of a checkout read root's spellings:
 * inside it, and not in `.git`, `.posse`, `.posse-worktrees` or the other
 * private dirs, nor a `.env*` entry, at any depth.
 */
export function checkoutReadRootContains(rootForms, target) {
  const resolved = path.resolve(String(target || ""));
  return rootForms.some((form) => {
    if (!isInside(form, resolved)) return false;
    const rel = path.relative(form, resolved);
    return !rel.split(path.sep).filter(Boolean).some((part) => {
      const lower = part.toLowerCase();
      return EXCLUDED_CHECKOUT_PARTS.has(lower) || lower.startsWith(".env");
    });
  });
}
