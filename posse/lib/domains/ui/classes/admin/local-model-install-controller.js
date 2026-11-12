// Admin's front end for the same install route as `posse local install <slug>`.
// It owns only what a full-screen UI needs: the size question, status text and
// cancellation. The install itself runs async in this process, so aborting it
// retires the native worker instead of orphaning a download.
import path from "node:path";
import { LOCAL_BRIDGE_MODELS } from "../../../../catalog/local-model.js";
import { defaultLocalGenerationModelRoot, defaultLocalGenerationRuntimeRoot } from "../../../../shared/native/functions/local-model-paths.js";
import { localBridgeModelInstallationStatus, localModelSupportsPlatform } from "../../../../shared/native/functions/local-model-defaults.js";
import { installLocalModel, openLocalRuntime } from "../../../cli/functions/local-install.js";
import { downloadQuestion, formatArtifactBytes } from "../../../cli/functions/local-models-command.js";

async function installWithDefaults(model, { signal, confirm, onStage, onProgress }) {
  const { nativeBinaries } = await import("../../../../shared/tools/classes/BinaryManager.js");
  const runtime = await openLocalRuntime({
    manager: nativeBinaries, signal, onProgress,
    modelRoot: path.resolve(defaultLocalGenerationModelRoot()),
    runtimeRoot: path.resolve(defaultLocalGenerationRuntimeRoot()),
  });
  return installLocalModel(model, runtime, { confirm, onStage });
}

function progressText(model, event) {
  const stage = String(event?.stage || "Working");
  const { downloadedBytes, totalBytes, file } = event || {};
  if (!Number.isFinite(downloadedBytes) || !Number.isFinite(totalBytes)) return `${stage}: ${model.slug}`;
  return `${stage} ${model.slug}: ${file} ${formatArtifactBytes(downloadedBytes)} / ${formatArtifactBytes(totalBytes)}`;
}

export class LocalModelInstallController {
  constructor({ install = installWithDefaults, render = () => {}, modelRoot = defaultLocalGenerationModelRoot() } = {}) {
    this._install = install;
    this._render = render;
    this._modelRoot = modelRoot;
    this._controller = null;
    this._prompt = null;
    this._status = "";
    this._exitHeld = false;
  }

  get active() { return this._controller !== null; }
  get prompting() { return this._prompt !== null; }

  get statusLine() {
    if (this._prompt) return `${this._prompt.text} [y] Yes  [n] No`;
    if (this.active && this._exitHeld) return `${this._status} · Exit again to cancel the download`;
    return this._status;
  }

  // What is on this machine and what could be added, one entry per model.
  inventory() {
    return LOCAL_BRIDGE_MODELS.map((model) => {
      const files = localBridgeModelInstallationStatus(this._modelRoot, model);
      const status = !localModelSupportsPlatform(model) ? "unsupported"
        : files === "present-unverified" ? "installed" : files === "incomplete" ? "incomplete" : "available";
      const detail = status === "installed" ? "files present; verified when used"
        : status === "incomplete" ? "incomplete files; not ready to use"
        : status === "available" ? `available, ${formatArtifactBytes(model.downloadBytes)} download`
          : "not supported on this machine";
      return { slug: model.slug, kind: model.kind, status, detail };
    });
  }

  choices() {
    return this.inventory().map(({ slug, kind, detail }) => ({ value: slug, label: `${slug} (${kind}, ${detail})` }));
  }

  start(slug) {
    const model = LOCAL_BRIDGE_MODELS.find((candidate) => candidate.slug === slug);
    if (!model || this.active) return;
    this._controller = new AbortController();
    this._exitHeld = false;
    this._setStatus(`Preparing ${model.slug}`);
    void this._run(model, this._controller);
  }

  answer(yes) {
    const prompt = this._prompt;
    this._prompt = null;
    prompt?.resolve(yes === true);
    this._render();
  }

  // Enter on the row while a download runs: asks first, like Esc does.
  requestCancel() {
    if (!this.active || this.prompting) return;
    void this._ask("Cancel this download?").then((yes) => { if (yes) this.cancel(); });
  }

  cancel() {
    this._controller?.abort(new DOMException("Local model install canceled", "AbortError"));
    this.answer(false);
  }

  // Image and video transfers restart from zero, so a stray Esc must not end one.
  holdExit() {
    if (!this.active || this._exitHeld) return false;
    this._exitHeld = true;
    this._render();
    return true;
  }

  async _run(model, controller) {
    let outcome;
    try {
      const { installed } = await this._install(model, {
        signal: controller.signal,
        confirm: (request) => this._ask(downloadQuestion(request)),
        onStage: (stage) => this._setStatus(`${stage}: ${model.slug}`),
        onProgress: (event) => this._setStatus(progressText(model, event)),
      });
      outcome = installed ? `${model.slug} installed and SHA-256 verified.` : `${model.slug} install canceled; nothing was downloaded.`;
    } catch (error) {
      outcome = controller.signal.aborted
        ? `${model.slug} install canceled.`
        : `${model.slug} install failed: ${String(error?.message || error).split("\n")[0]}`;
    }
    this._controller = null;
    this._prompt = null;
    this._setStatus(outcome);
  }

  _ask(text) {
    return new Promise((resolve) => {
      this._prompt = { text, resolve };
      this._render();
    });
  }

  _setStatus(text) {
    this._status = text;
    this._render();
  }
}
