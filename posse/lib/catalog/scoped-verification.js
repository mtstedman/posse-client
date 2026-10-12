// @ts-check
import { readonlySet } from "./readonly-collections.js";



export const JS_SOURCE_EXTENSIONS = readonlySet([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);

export const PHP_SOURCE_EXTENSIONS = readonlySet([".php"]);

export const PYTHON_SOURCE_EXTENSIONS = readonlySet([".py", ".pyi"]);

export const GO_SOURCE_EXTENSIONS = readonlySet([".go"]);

export const RUST_SOURCE_EXTENSIONS = readonlySet([".rs"]);

export const C_SOURCE_EXTENSIONS = readonlySet([".c", ".h"]);

export const CPP_SOURCE_EXTENSIONS = readonlySet([".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"]);

export const RUBY_SOURCE_EXTENSIONS = readonlySet([".rb"]);

export const SHELL_SOURCE_EXTENSIONS = readonlySet([".sh", ".bash"]);

export const CLANG_SOURCE_EXTENSIONS = readonlySet([...C_SOURCE_EXTENSIONS, ...CPP_SOURCE_EXTENSIONS]);

export const SOURCE_EXTENSIONS = readonlySet([
  ...JS_SOURCE_EXTENSIONS,
  ...PHP_SOURCE_EXTENSIONS,
  ...PYTHON_SOURCE_EXTENSIONS,
  ...GO_SOURCE_EXTENSIONS,
  ...RUST_SOURCE_EXTENSIONS,
  ...CLANG_SOURCE_EXTENSIONS,
  ...RUBY_SOURCE_EXTENSIONS,
  ...SHELL_SOURCE_EXTENSIONS,
]);

export const MAX_SCOPE_ROOT_FILES = 250;

export const MAX_FAILURES = 60;

export const MAX_OUTPUT_CHARS = 6000;

// A verifier whose runner binary is missing (no node_modules in a fresh
// worktree, a package script whose tool is not installed) is a dependency
// problem, not a product failure. Mirror the other runners' "unavailable"
// contract so assessment can repair the worktree or defer, instead of
// failing the change and spawning fix jobs for code that is correct.
export const MISSING_TOOLING_RE = /(?:^|\n)\s*(?:\/bin\/)?sh: (?:\d+: )?[\w@./-]+: (?:command )?not found|(?:^|\n)\s*[\w@./-]+: (?:command )?not found|\bENOENT\b|node_modules missing|Cannot find module ['"]?(?:eslint|typescript|tsc)\b/i;

// Top-level static import/export, or import.meta, outside comments.
export const ESM_SYNTAX_RE = /^[ \t]*(?:import[ \t]*[\w{*'"]|export[ \t]*[\w{*])|\bimport\.meta\b/m;
