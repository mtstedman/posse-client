import fs from "node:fs/promises";
import { defaultLocalGenerationModelRoot, defaultLocalGenerationRuntimeRoot } from "../../../shared/native/functions/local-model-paths.js";
import path from "node:path";
import { LOCAL_BRIDGE_MODELS } from "../../../catalog/local-model.js";
import { ML_CAPABILITIES_METHOD, ML_GENERATE_METHOD, ML_GENERATE_IMAGE_METHOD, ML_INSTALL_IMAGE_MODEL_METHOD } from "../../../catalog/binary.js";
import { LocalModelProgress } from "../classes/LocalModelProgress.js";
import { LOCAL_USAGE, numericOption, parseLocalOptions } from "./local-options.js";
import { checkLocalOutput, encodeLocalOutput, readLocalPrompt, writeLocalOutput } from "./local-output.js";

export { LOCAL_USAGE };
const LONG_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export async function runLocalCli(argv = process.argv.slice(3), io = {}) {
  const args = parseLocalOptions(argv);
  const stdout = io.stdout || process.stdout, stderr = io.stderr || process.stderr, stdin = io.stdin || process.stdin;
  if (args.help || !argv.length) { stdout.write(LOCAL_USAGE + "\n"); return 0; }
  const modelRoot = path.resolve(args["model-root"] || defaultLocalGenerationModelRoot());
  if (args.action === "list") {
    const models = await Promise.all(LOCAL_BRIDGE_MODELS.map(async model => {
      const location = path.join(modelRoot, model.directory);
      const exists = await fs.lstat(location).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      return { ...model, path: location, installationStatus: exists?.isDirectory() && !exists.isSymbolicLink() ? "present-unverified" : "not-installed",
        platformSupported: model.platforms.includes(`${process.platform}-${process.arch}`), installable: model.platforms.includes(`${process.platform}-${process.arch}`) };
    }));
    if (args.json || args.format === "json") stdout.write(JSON.stringify({ modelRoot, models }) + "\n");
    else {
      stdout.write("SLUG          TYPE   FILES                 PLATFORM\n");
      for (const model of models) stdout.write(`${model.slug.padEnd(14)}${model.kind.padEnd(7)}${model.installationStatus.padEnd(22)}${model.platformSupported ? 'supported; runtime checks apply' : 'unsupported'}\n  ${model.modelId}\n`);
      stdout.write("\nPresent files are SHA-verified by the native runtime when used.\nInstall: posse local install <slug>\n");
    }
    return 0;
  }
  const model = LOCAL_BRIDGE_MODELS.find(m => m.slug === args.model || m.modelId === args.model);
  if (!model) throw new Error("Choose a model with --model <slug>. Run posse local list for available slugs.");
  let payload, format;
  if (args.action === "generate") {
    format = args.format || model.formats[0];
    if (!model.formats.includes(format)) throw new Error(`${model.slug} supports --format ${model.formats.join('|')}.`);
    await checkLocalOutput(args.output, format, stdout);
    payload = await generationPayload(model, args, stdin);
  } else if (model.kind === "text" && args.source) {
    throw new Error("--source is only supported for image model files; text models use signed packages.");
  }
  const progress = new LocalModelProgress(stderr, { quiet: args.quiet });
  const controller = new AbortController();
  const onSignal = () => controller.abort(new DOMException("Local model operation canceled", "AbortError"));
  const signal = io.signal ? AbortSignal.any([controller.signal, io.signal]) : controller.signal;
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let manager;
  progress.start();
  try {
    signal.throwIfAborted();
    manager = io.manager || (await import("../../../shared/tools/classes/BinaryManager.js")).nativeBinaries;
    const invoke = io.invoke || (await import("../../../shared/native/functions/ml-invoke.js")).runMlNativeMethodAsync;
    const available = await manager.ensureAvailable("ml", { refresh: true });
    if (available?.available !== true) throw new Error(`Native ML runtime unavailable: ${available?.reason || 'unknown'}`);
    signal.throwIfAborted();
    const options = { manager, modelRoot, signal, timeoutMs: LONG_TIMEOUT_MS, idempotent: false,
      runtimeRoot: path.resolve(args["runtime-root"] || defaultLocalGenerationRuntimeRoot()),
      onProgress: event => progress.update(event) };
    const caps = (await invoke(ML_CAPABILITIES_METHOD, {}, options))?.capabilities;
    const capability = model.kind === "image" ? caps?.imageGeneration : caps?.generation;
    if (!(model.kind === "image" ? capability?.supported : capability?.runtime?.supported)
      || !capability?.models?.some(m => m.id === model.modelId)) {
      throw new Error(`${model.slug} is unavailable in this native runtime/platform. Install an updated posse-ml artifact supporting this model.`);
    }
    if (args.action === "install") {
      progress.stop();
      if (model.kind === "text") {
        const install = io.installText || (await import("./local-models-command.js")).runLocalModelsCommand;
        await install(["download", model.slug], { input: stdin, output: stderr, nonInteractive: args["non-interactive"], modelRoot,
          downloadModel: async (client, id, opts) => {
            const { downloadLocalModelPackage } = await import("../../remote/functions/local-model-artifacts.js");
            progress.label = "Downloading signed model package";
            progress.start();
            try { return await downloadLocalModelPackage(client, id, { ...opts, signal }); }
            finally { progress.stop(); }
          },
          installModel: async (method, data, opts) => {
            signal.throwIfAborted();
            progress.label = "Installing verified model package";
            progress.start();
            try { return await invoke(method, data, { ...opts, signal, onProgress: event => progress.update(event), idempotent: false }); }
            finally { progress.stop(); }
          } });
      } else {
        let request = { modelId: model.modelId, sourceDirectory: args.source ? path.resolve(args.source) : undefined };
        if (!args.source) {
          if (!capability.installation?.includes("pinned-download")) throw new Error("This native runtime supports local-file installation only; update posse-ml or use --source DIR.");
          if (args["non-interactive"] || !stdin.isTTY || !stderr.isTTY) throw new Error("Model downloads require interactive size confirmation; use --source DIR for already-downloaded files.");
          const asset = capability.models.find(m => m.id === model.modelId);
          if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) throw new Error("Native model download size is missing.");
          const ask = io.askChoice || (await import("./input-prompts.js")).askSelectorChoice;
          const answer = await ask(`Download ${model.slug}: ${(asset.bytes / 1024 ** 3).toFixed(2)} GiB (${asset.bytes} bytes)?`,
            [{ value: "no", label: "No" }, { value: "yes", label: "Yes, download" }], { defaultValue: "no", input: stdin, output: stderr });
          if (answer !== "yes") { stderr.write("Installation canceled.\n"); return 0; }
          request = { modelId: model.modelId, download: true };
        }
        signal.throwIfAborted();
        progress.start();
        await invoke(ML_INSTALL_IMAGE_MODEL_METHOD, request, options);
        progress.stop();
        stderr.write(`${model.slug} installed and SHA-256 verified.\n`);
      }
      return 0;
    }
    progress.update({ stage: `Loading ${model.slug}` });
    let result;
    try {
      result = await invoke(model.kind === "image" ? ML_GENERATE_IMAGE_METHOD : ML_GENERATE_METHOD, payload, options);
    } catch (error) {
      if (error?.name !== "AbortError" && /inspect directory|not installed|No such file/i.test(error?.message || "")) {
        throw new Error(`${model.slug} is not installed or its files are incomplete. Run: posse local install ${model.slug} --model-root ${JSON.stringify(modelRoot)}`, { cause: error });
      }
      throw error;
    }
    signal.throwIfAborted();
    const bytes = encodeLocalOutput(result, model, format);
    progress.stop();
    await writeLocalOutput(bytes, args.output, stdout);
    if (!args.quiet) stderr.write(args.output && args.output !== "-" ? `Saved ${path.resolve(args.output)}\n` : "Generation complete.\n");
    return 0;
  } finally {
    progress.stop();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (!io.manager) await manager?.disposeAll?.();
  }
}

async function generationPayload(model, args, input) {
  const imageFlags = ["steps", "width", "height", "threads", "cfg-scale", "negative-prompt"];
  const textFlags = ["max-tokens", "system"];
  for (const flag of model.kind === "image" ? textFlags : imageFlags) if (args[flag] !== undefined) throw new Error(`--${flag} does not apply to ${model.kind} models.`);
  const prompt = await readLocalPrompt(args, input, model.kind === "image" ? 8192 : 262144);
  if (model.kind === "image") {
    const negativePrompt = args["negative-prompt"] || "";
    if (negativePrompt.includes("\0") || Buffer.byteLength(negativePrompt) > 8192) throw new Error("Negative prompt must be NUL-free and at most 8192 bytes.");
    return { modelId: model.modelId, prompt, negativePrompt,
      width: numericOption(args, "width", 384, 64, 1024, 16), height: numericOption(args, "height", 384, 64, 1024, 16),
      steps: numericOption(args, "steps", 20, 1, 50), threads: numericOption(args, "threads", 8, 1, 32),
      seed: numericOption(args, "seed", 42, 0, 4294967295), cfgScale: numericOption(args, "cfg-scale", 2.5, 1, 10, 0) };
  }
  if (args.seed !== undefined) throw new Error("Text generation currently uses deterministic greedy decoding; --seed applies to images.");
  if (args.system && (Buffer.byteLength(args.system) > 262144 || args.system.includes("\0"))) throw new Error("System prompt is too large or contains NUL.");
  return { modelId: model.modelId, messages: [...(args.system ? [{ role: "system", content: args.system }] : []), { role: "user", content: prompt }],
    generation: { mode: "greedy", maxOutputTokens: numericOption(args, "max-tokens", 512, 1, 4096) } };
}
