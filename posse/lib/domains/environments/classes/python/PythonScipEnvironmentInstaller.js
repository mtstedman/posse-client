// @ts-check

import { NodeScipEnvironmentInstaller } from "../NodeScipEnvironmentInstaller.js";

export class PythonScipEnvironmentInstaller extends NodeScipEnvironmentInstaller {
  get language() {
    return "python";
  }

  get commandName() {
    return "scip-python";
  }
}
