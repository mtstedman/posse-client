// @ts-check
//
// Compatibility entry point for Posse-managed SCIP dependency setup. The
// language-specific installers live under domains/environments/classes.

export {
  getScipLanguageDependencyStatus,
  getScipLanguageInstallPlan,
  installScipLanguageDependencies,
  installScipLanguageDependenciesSync,
} from "../../../../environments/classes/ScipLanguageInstallManager.js";
