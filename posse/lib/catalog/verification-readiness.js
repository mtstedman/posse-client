// @ts-check
import { WORKSPACE_TRAVERSAL_PROFILES } from "./workspace-traversal.js";
import { readonlySet } from "./readonly-collections.js";



export const ROOT_MARKERS = Object.freeze([
  "package.json",
  "pyproject.toml",
  "setup.cfg",
  "Cargo.toml",
  "go.mod",
  "composer.json",
]);

export const PACKAGE_DISCOVERY_SKIP_DIRS = WORKSPACE_TRAVERSAL_PROFILES.package_discovery;

export const MAX_DISCOVERED_PACKAGE_ROOTS = 64;

export const JS_PROJECT_EXTENSIONS = readonlySet([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
