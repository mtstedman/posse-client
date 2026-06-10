// @ts-check
//
// Shared runtime catalog for ATLAS runtime.execute. Validation, descriptors,
// docs, and the executor all derive from this table.

export const ATLAS_RUNTIME_SPECS = Object.freeze([
  runtimeSpec("node", ["node", "js", "javascript"], ".js", { win32: "node", unix: "node" }),
  runtimeSpec("typescript", ["typescript", "ts", "tsx", "ts-node", "bun"], ".ts", { win32: "tsx", unix: "tsx" }),
  runtimeSpec("python", ["python", "python3", "py"], ".py", { win32: "python", unix: "python3" }),
  runtimeSpec("shell", ["shell", "bash", "sh", "cmd", "powershell", "pwsh"], { win32: ".ps1", unix: ".sh" }, { win32: "powershell", unix: "bash" }, "shell"),
  runtimeSpec("ruby", ["ruby"], ".rb", { win32: "ruby", unix: "ruby" }),
  runtimeSpec("php", ["php"], ".php", { win32: "php", unix: "php" }),
  runtimeSpec("perl", ["perl"], ".pl", { win32: "perl", unix: "perl" }),
  runtimeSpec("r", ["r", "rscript"], ".R", { win32: "Rscript", unix: "Rscript" }),
  runtimeSpec("elixir", ["elixir"], ".exs", { win32: "elixir", unix: "elixir" }),
  runtimeSpec("go", ["go", "golang"], ".go", { win32: "go", unix: "go" }, "go"),
  runtimeSpec("java", ["java"], ".java", { win32: "java", unix: "java" }),
  runtimeSpec("kotlin", ["kotlin", "kts"], ".kts", { win32: "kotlin", unix: "kotlin" }),
  runtimeSpec("rust", ["rust", "rustc"], ".rs", { win32: "rustc", unix: "rustc" }),
  runtimeSpec("c", ["c", "gcc", "cc"], ".c", { win32: "gcc", unix: "gcc" }),
  runtimeSpec("cpp", ["cpp", "c++", "g++"], ".cpp", { win32: "g++", unix: "g++" }),
  runtimeSpec("csharp", ["csharp", "cs", "dotnet-script"], ".csx", { win32: "dotnet-script", unix: "dotnet-script" }),
]);

export const ATLAS_RUNTIME_NAMES = Object.freeze(ATLAS_RUNTIME_SPECS.map((spec) => spec.name));
export const ATLAS_RUNTIME_INPUTS = Object.freeze([...new Set(
  ATLAS_RUNTIME_SPECS.flatMap((spec) => [spec.name, ...spec.aliases]),
)]);

/** @typedef {(typeof ATLAS_RUNTIME_NAMES)[number]} AtlasRuntimeName */
/** @typedef {(typeof ATLAS_RUNTIME_INPUTS)[number]} AtlasRuntimeInput */

/**
 * @param {string} name
 * @param {string[]} aliases
 * @param {string | { win32: string, unix: string }} extension
 * @param {{ win32: string, unix: string }} command
 * @param {"default" | "shell" | "go"} [codeArgs]
 */
function runtimeSpec(name, aliases, extension, command, codeArgs = "default") {
  return Object.freeze({
    name,
    aliases: [...new Set(aliases)],
    extension,
    command,
    codeArgs,
  });
}
