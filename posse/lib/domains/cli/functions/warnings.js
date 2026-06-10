const WARNING_FILTER_INSTALLED = Symbol.for("posse.cli.warningFilterInstalled");

export function installCliWarningFilter({
  processLike = process,
  suppressedCodes = ["DEP0040"],
  warn = (warning) => console.warn(warning),
} = {}) {
  if (processLike[WARNING_FILTER_INSTALLED]) return false;
  const suppressed = new Set(suppressedCodes.map((code) => String(code)));
  processLike.on("warning", (warning) => {
    if (suppressed.has(String(warning?.code || ""))) return;
    warn(warning);
  });
  processLike[WARNING_FILTER_INSTALLED] = true;
  return true;
}

export const __testWarningFilterInstalledSymbol = WARNING_FILTER_INSTALLED;
