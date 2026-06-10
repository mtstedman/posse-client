import { runGitNativeMethod, runGitNativeMethodAsync } from "./native/invoke.js";

export const SAFE_PUSH_REFSPEC = "HEAD";

export function pushRefspecCanPublishSnapshotRefs(refspec, nativeParity = {}) {
  return Boolean(runGitNativeMethod(
    "git.push.refspecCanPublishSnapshotRefs",
    { refspec: String(refspec || "") },
    nativeParity,
  ));
}

export function snapshotPublishingPushConfigs(cwd, nativeParity = {}) {
  return runGitNativeMethod("git.snapshotPublishingPushConfigs", { cwd }, nativeParity);
}

export async function snapshotPublishingPushConfigsAsync(cwd, nativeParity = {}) {
  return runGitNativeMethodAsync("git.snapshotPublishingPushConfigs", { cwd }, nativeParity);
}

function gitNativeOptions(options = {}) {
  return options.nativeParity || options;
}

export function ensureRestrictivePushRefspecs(cwd, options = {}) {
  const result = runGitNativeMethod(
    "git.ensureRestrictivePushRefspecs",
    { cwd },
    gitNativeOptions(options),
  );
  return Array.isArray(result?.changed) ? result.changed : [];
}
