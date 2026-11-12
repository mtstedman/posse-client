import fs from "node:fs/promises";
import { defaultLocalGenerationModelRoot, defaultLocalGenerationRuntimeRoot } from "../../../shared/native/functions/local-model-paths.js";
import path from "node:path";
import { LOCAL_BRIDGE_MODELS } from "../../../catalog/local-model.js";
import { ML_GENERATE_METHOD, ML_GENERATE_IMAGE_METHOD, ML_GENERATE_VIDEO_METHOD } from "../../../catalog/binary.js";
import { LocalModelProgress } from "../classes/LocalModelProgress.js";
import { LOCAL_USAGE, parseLocalOptions } from "./local-options.js";
import { checkLocalOutput, encodeLocalOutput, readLocalPrompt, writeLocalOutput } from "./local-output.js";
import { requireLocalModelCapability } from "./local-capabilities.js";
import { installLocalModel, openLocalRuntime } from "./local-install.js";
import { resolveDefaultLocalModel } from "../../../shared/native/functions/local-model-defaults.js";
import { LOCAL_DEFAULT_MODELS } from "../../../catalog/local-model.js";
import { getSetting } from "../../settings/functions/repository-settings.js";
import { resolveLocalParameters, resolveLocalModel, localModelHelp } from "./local-parameters.js";
import { selectGenerationGpu, writeImageGpuInventory } from "./local-gpu.js";
import { requireFirstFrameCapability } from "./local-video-media.js";
import { LocalVideoContinuation } from "../classes/LocalVideoContinuation.js";

export { LOCAL_USAGE };

export async function runLocalCli(argv = process.argv.slice(3), io = {}) {
  let args = parseLocalOptions(argv);
  const stdout = io.stdout || process.stdout, stderr = io.stderr || process.stderr, stdin = io.stdin || process.stdin;
  if (args.help || !argv.length) {
    stdout.write((args.model ? localModelHelp(resolveLocalModel(args.model), io.readSetting) : LOCAL_USAGE) + "\n");
    return 0;
  }
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
  if (args.kind !== undefined && (args.model || args.action !== "generate")) throw new Error("--kind selects the default model for a generation; use it without --model.");
  const model = args.action === "gpus" && !args.model ? LOCAL_BRIDGE_MODELS.find(m => m.kind === "image")
    : args.kind !== undefined ? defaultModelForKind(args.kind, modelRoot, io.readSetting || getSetting)
      : resolveLocalModel(args.model);
  if (args.action === "gpus" && model.kind === "text") throw new Error("GPU discovery currently applies to image and video models.");
  let payload, format, parameters;
  if (args.action === "generate") {
    ({ args, parameters } = resolveLocalParameters(model, args, io.readSetting));
    format = args.format || model.formats[0];
    if (!model.formats.includes(format)) throw new Error(`${model.slug} supports --format ${model.formats.join('|')}.`);
    await checkLocalOutput(args.output, format, stdout);
    payload = await generationPayload(model, args, parameters, stdin);
  } else if (model.installation === "signed-package" && args.source) {
    throw new Error(`--source is only supported for pinned model files; ${model.slug} installs as a signed package.`);
  }
  const progress = new LocalModelProgress(stderr, { quiet: args.quiet });
  const controller = new AbortController();
  const onSignal = () => controller.abort(new DOMException("Local model operation canceled", "AbortError"));
  const signal = io.signal ? AbortSignal.any([controller.signal, io.signal]) : controller.signal;
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let manager, videoInput;
  progress.start();
  try {
    signal.throwIfAborted();
    manager = io.manager || (await import("../../../shared/tools/classes/BinaryManager.js")).nativeBinaries;
    const runtime = await openLocalRuntime({ manager, invoke: io.invoke, modelRoot, signal,
      runtimeRoot: path.resolve(args["runtime-root"] || defaultLocalGenerationRuntimeRoot()),
      onProgress: event => progress.update(event) });
    const { invoke, options, capabilities: caps, version } = runtime;
    if (args.action === "gpus") {
      progress.stop();
      writeImageGpuInventory(model.kind === "video" ? caps?.videoGeneration : caps?.imageGeneration, version, stdout, args.json || args.format === "json");
      return 0;
    }
    if (args.action === "install") {
      progress.stop();
      const { installed } = await installLocalModel(model, runtime, {
        source: args.source, artifacts: io.modelArtifacts,
        confirm: request => confirmDownload(request, model, args, { stdin, stderr, askChoice: io.askChoice }),
        onStage: stage => { progress.label = stage; progress.start(); },
      });
      progress.stop();
      if (installed) stderr.write(`${model.slug} installed and SHA-256 verified.\n`);
      return 0;
    }
    const capability = requireLocalModelCapability(model, caps, { version });
    if (model.kind === "video" && (parameters.firstFrame !== undefined || parameters.continueFrom !== undefined)) {
      requireFirstFrameCapability(capability);
      progress.update({ stage: parameters.continueFrom ? "Extracting previous video's last frame" : "Reading first frame" });
      videoInput = await LocalVideoContinuation.prepare(parameters, args, signal);
      payload.width = videoInput.width;
      payload.height = videoInput.height;
      payload.firstFrame = videoInput.firstFrame;
    }
    if (model.kind !== "text") {
      progress.stop();
      const device = await selectGenerationGpu(capability, { ...args, gpu: parameters.gpu }, { version, stdin, stderr, askChoice: io.askChoice });
      signal.throwIfAborted();
      if (device) {
        payload.gpu = true;
        payload.gpuId = device.id;
        if (!args.quiet) stderr.write(`Using GPU ${device.id}\n`);
      }
      progress.start();
    }
    progress.update({ stage: `Loading ${model.slug}` });
    let result;
    try {
      result = await invoke(model.kind === "video" ? ML_GENERATE_VIDEO_METHOD : model.kind === "image" ? ML_GENERATE_IMAGE_METHOD : ML_GENERATE_METHOD, payload, options);
    } catch (error) {
      if (error?.name !== "AbortError" && /inspect directory|not installed|No such file/i.test(error?.message || "")) {
        throw new Error(`${model.slug} is not installed or its files are incomplete. Run: posse local install ${model.slug} --model-root ${JSON.stringify(modelRoot)}`, { cause: error });
      }
      throw error;
    }
    signal.throwIfAborted();
    let bytes = encodeLocalOutput(result, model, videoInput?.source ? "avi" : format);
    if (videoInput?.source) {
      progress.update({ stage: "Stitching video continuation" });
      bytes = await videoInput.stitch(result, bytes, format);
    }
    signal.throwIfAborted();
    progress.stop();
    await writeLocalOutput(bytes, args.output, stdout);
    if (!args.quiet) stderr.write(args.output && args.output !== "-" ? `Saved ${path.resolve(args.output)}\n` : "Generation complete.\n");
    return 0;
  } finally {
    progress.stop();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await videoInput?.dispose();
    if (!io.manager) await manager?.disposeAll?.();
  }
}

function defaultModelForKind(kind, modelRoot, readSetting) {
  const kinds = LOCAL_DEFAULT_MODELS.map(entry => entry.kind);
  if (!kinds.includes(kind)) throw new Error(`--kind must be one of ${kinds.join(", ")}.`);
  const model = resolveDefaultLocalModel(kind, { modelRoot, readSetting });
  if (!model) throw new Error(`No local ${kind} model is installed. Run posse local list, then posse local install <slug>.`);
  return model;
}

async function confirmDownload({ label, bytes, artifact }, model, args, { stdin, stderr, askChoice }) {
  if (args["non-interactive"] || !stdin.isTTY || !stderr.isTTY) {
    throw new Error(`Model downloads require interactive size confirmation.${model.installation === "signed-package" ? "" : " Use --source DIR for already-downloaded files."}`);
  }
  const { downloadQuestion, renderLocalModelArtifact } = await import("./local-models-command.js");
  if (artifact) renderLocalModelArtifact(artifact, { output: stderr });
  const ask = askChoice || (await import("./input-prompts.js")).askSelectorChoice;
  const answer = await ask(downloadQuestion({ label, bytes }),
    [{ value: "no", label: "No" }, { value: "yes", label: "Yes, download" }], { defaultValue: "no", input: stdin, output: stderr });
  if (answer === "yes") return true;
  stderr.write("Installation canceled; no model bytes were requested.\n");
  return false;
}

async function generationPayload(model, args, parameters, input) {
  const prompt = await readLocalPrompt(args, input, model.kind !== "text" ? 8192 : 262144);
  if (model.kind !== "text") {
    // GPU mode and selection belong to the CLI; native generation accepts a
    // boolean and the exact resolved device ID, never auto/on/off.
    const { gpu: _gpu, gpuId: _gpuId, firstFrame: _firstFrame, continueFrom: _continueFrom, ...settings } = parameters;
    return { modelId: model.modelId, prompt, ...settings };
  }
  const { temperature, topP, topK, seed } = parameters;
  return { modelId: model.modelId,
    messages: [...(parameters.system ? [{ role: "system", content: parameters.system }] : []), { role: "user", content: prompt }],
    generation: temperature === undefined ? { mode: "greedy", maxOutputTokens: parameters.maxOutputTokens }
      : { mode: "sample", maxOutputTokens: parameters.maxOutputTokens, temperature, topP, topK, ...(seed === undefined ? {} : { seed }) } };
}
