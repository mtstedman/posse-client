import fs from "node:fs";
import path from "node:path";
import { BOSSY_ATLAS_READ_DEFINITIONS, BOSSY_ATLAS_READ_LIMITS } from "../../../catalog/bossy-atlas.js";
import { validateToolArguments } from "../../../shared/tools/functions/schema-validation.js";
import { validateAtlasToolCall } from "./v2/contracts/tool-schemas.js";
import { isSensitiveEnvFileOrTargetPath } from "../../runtime/functions/sensitive-paths.js";
import { mainViewPath, ledgerDbPath } from "./v2/runtime-paths.js";

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = (value) => value && typeof value === "object" && !Array.isArray(value);

// Validate every explicit path selector before calling the owner executor.
// Symbol IDs remain scoped by the executor's fixed view/ledger/read root.
function checkPaths(input, root) {
  if (!input || typeof input !== "object") return;
  for (const [key, value] of Object.entries(input)) {
    if (["file", "path", "paths"].includes(key)) {
      for (const selector of Array.isArray(value) ? value : [value]) {
        if (typeof selector !== "string") throw new Error("Atlas path must be a string");
        const portable = selector.replaceAll("\\", "/");
        if (portable.includes("\0") || path.posix.isAbsolute(portable) || path.win32.isAbsolute(selector)
          || portable.split("/").includes("..") || /^[a-zA-Z]:/.test(portable)
          || portable.split("/").some((part) => [".git", ".posse"].includes(part.toLowerCase()))) {
          throw new Error("Atlas path must stay within repository source");
        }
        let target = path.resolve(root, portable);
        if (isSensitiveEnvFileOrTargetPath(target)) throw new Error("Atlas path is a protected environment file");
        // Prefix queries can name absent paths. Resolve the nearest existing
        // ancestor to reject directory symlinks even for missing descendants.
        while (!fs.existsSync(target)) {
          try { fs.lstatSync(target); throw new Error("Atlas path has a dangling symlink"); }
          catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
          const parent = path.dirname(target);
          if (parent === target) throw new Error("Atlas path unavailable");
          target = parent;
        }
        const real = fs.realpathSync(target);
        if (real !== root && !real.startsWith(root + path.sep)) throw new Error("Atlas path resolves outside repository");
        if (path.relative(root, real).split(path.sep).some((part) => [".git", ".posse"].includes(part.toLowerCase()))) throw new Error("Atlas path resolves to repository control data");
      }
    } else if (value && typeof value === "object") checkPaths(value, root);
  }
}

export async function readBossyAtlas(request, { repoRoot, executor = null } = {}) {
  if (!object(request) || request.version !== 1 || Object.keys(request).some((key) => !["version", "action", "input"].includes(key))) {
    throw new Error("Expected Atlas read protocol version 1");
  }
  if (Buffer.byteLength(JSON.stringify(request)) > BOSSY_ATLAS_READ_LIMITS.inputBytes) throw new Error("Atlas request exceeds 16 KiB");
  const input = request.input ?? {};
  if (!object(input)) throw new Error("Atlas input must be an object");
  if (request.action === "manual") {
    if (Object.keys(input).some((key) => key !== "action")) throw new Error("manual accepts only action");
    if (own(input, "action")) {
      if (typeof input.action !== "string" || !own(BOSSY_ATLAS_READ_DEFINITIONS, input.action)) throw new Error("Atlas action is not available for read-only inspection");
      return { version: 1, result: BOSSY_ATLAS_READ_DEFINITIONS[input.action] };
    }
    return { version: 1, result: { actions: Object.values(BOSSY_ATLAS_READ_DEFINITIONS).map(({ action, description }) => ({ action, description })), limits: BOSSY_ATLAS_READ_LIMITS } };
  }
  if (typeof request.action !== "string" || !own(BOSSY_ATLAS_READ_DEFINITIONS, request.action)) throw new Error("Atlas action is not available for read-only inspection");
  const definition = BOSSY_ATLAS_READ_DEFINITIONS[request.action];
  const checked = validateToolArguments(definition, input);
  if (!checked.ok) throw new Error(checked.message);
  const nativeChecked = validateAtlasToolCall({ ...input, action: request.action });
  if (!nativeChecked.ok) throw new Error(nativeChecked.errors.map((error) => error.message).join("; "));
  const root = fs.realpathSync(repoRoot);
  checkPaths(input, root);
  const context = {
    repoRoot: root, readRoot: root, storageRepoPath: root,
    viewPath: mainViewPath(root), ledgerPath: ledgerDbPath(root), versionId: "main",
    config: { repoRoot: root, readRoot: root, usageTelemetryEnabled: false,
      codeWindowPolicy: { maxWindowLines: 400, maxWindowTokens: 6000 } },
  };
  for (const location of [context.viewPath, context.ledgerPath]) {
    if (!fs.existsSync(location)) throw new Error("Atlas index unavailable; refresh Atlas through the reviewed maintenance action");
    if (!fs.realpathSync(location).startsWith(root + path.sep)) throw new Error("Atlas index resolves outside repository");
  }
  let owned = false;
  if (!executor) {
    const { AtlasToolExecutor } = await import("../classes/v2/AtlasToolExecutor.js");
    executor = new AtlasToolExecutor({ nativeViewMigrationRepair: async () => false });
    owned = true;
  }
  try {
    // Supplying the read context also prevents non-native retrieval actions
    // from falling back to a conductor boot that could warm/register a repo.
    executor.setReadContext(root, context);
    const result = await executor.executeTool({
      toolName: `atlas_${request.action.replaceAll(".", "_")}`, args: input,
      config: context.config, waitMs: BOSSY_ATLAS_READ_LIMITS.timeoutMs,
      source: { kind: "bossy-repository-read" },
    });
    if (result?.ok === false || result?.result?.isError === true) throw new Error(result.errorMsg || "Atlas retrieval failed");
    const content = result?.result?.content;
    const text = Array.isArray(content) ? content.filter((item) => item.type === "text").map((item) => item.text).join("\n") : JSON.stringify(result);
    return { version: 1, result: { action: request.action, text: text.slice(0, BOSSY_ATLAS_READ_LIMITS.outputChars), truncated: text.length > BOSSY_ATLAS_READ_LIMITS.outputChars } };
  } finally {
    if (owned) await executor.close();
  }
}

export async function runBossyAtlasReadCli({ stdin = process.stdin, stdout = process.stdout, repoRoot = process.cwd() } = {}) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > BOSSY_ATLAS_READ_LIMITS.inputBytes) throw new Error("Atlas request exceeds 16 KiB");
    chunks.push(Buffer.from(chunk));
  }
  const response = await readBossyAtlas(JSON.parse(Buffer.concat(chunks).toString("utf8")), { repoRoot });
  stdout.write(`${JSON.stringify(response)}\n`);
}
