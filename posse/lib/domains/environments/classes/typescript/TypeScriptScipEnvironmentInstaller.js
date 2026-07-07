// @ts-check

import { NodeScipEnvironmentInstaller } from "../NodeScipEnvironmentInstaller.js";

export class TypeScriptScipEnvironmentInstaller extends NodeScipEnvironmentInstaller {
  get language() {
    return "typescript";
  }

  get commandName() {
    return "scip-typescript";
  }
}
