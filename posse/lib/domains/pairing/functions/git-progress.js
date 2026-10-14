import { DependencyProgress } from "../../cli/classes/DependencyProgress.js";

// Own the live row for the entire operation, including retries and quiet waits.
export async function withPairingGitProgress(operation, options = {}) {
  const progress = new DependencyProgress({ title: "Pair Git sync", ...options });
  progress.start("connecting");
  try {
    const result = await operation((message) => progress.update(message));
    progress.finish("ready");
    return result;
  } finally {
    progress.stop();
  }
}
