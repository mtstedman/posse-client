// @ts-check

import { NodeScipEnvironmentInstaller } from "../NodeScipEnvironmentInstaller.js";
import {
  ensureManagedPythonTestToolchain,
  inspectManagedPythonTestToolchain,
} from "../../functions/python-test-toolchain.js";

export class PythonScipEnvironmentInstaller extends NodeScipEnvironmentInstaller {
  get language() {
    return "python";
  }

  get commandName() {
    return "scip-python";
  }

  installPlan() {
    return [
      ...super.installPlan(),
      "ensure shared Python + pytest test toolchain",
    ];
  }

  async install() {
    const indexer = await super.install();
    const testToolchain = await this.runStep(5, "ensure shared Python + pytest test toolchain", async () => (
      ensureManagedPythonTestToolchain({
        posseRoot: this.posseRoot,
        dryRun: this.dryRun,
        timeoutMs: this.timeoutMs,
      })
    ));
    if (!indexer?.ok) {
      const runner = testToolchain?.ok ? "shared Python + pytest test toolchain ready" : testToolchain?.message;
      return this.failed([indexer?.message, runner].filter(Boolean).join("; "));
    }
    if (!testToolchain?.ok) return this.failed(testToolchain?.message || "shared Python test toolchain install failed");
    const status = indexer.status === "installed" || testToolchain.status === "installed"
      ? "installed"
      : (indexer.status === "dry-run" || testToolchain.status === "dry-run" ? "dry-run" : "ok");
    return this.ok(status, `${this.commandName} and shared Python + pytest test toolchain ready`);
  }

  status() {
    const indexer = super.status();
    if (!indexer.ok) return indexer;
    const testToolchain = inspectManagedPythonTestToolchain(this.posseRoot);
    return testToolchain.ready
      ? this.ok("ok", `${this.commandName} and shared Python + pytest test toolchain installed`)
      : this.failed(`missing shared Python + pytest test toolchain at ${testToolchain.runtimeDir}`);
  }
}
