import { normalizeToolReference } from "../../../catalog/tool-references.js";

function normalizeProviderName(providerName = "") {
  return String(providerName || "").trim().toLowerCase();
}

function issuedToolsFrom(surface) {
  if (Array.isArray(surface)) return surface;
  if (Array.isArray(surface?.tools)) return surface.tools;
  return [];
}

function canonicalNameFor(tool = {}) {
  return String(tool?.canonicalName || tool?.name || "").trim();
}

function suiteFor(tool = {}) {
  const explicit = String(tool?.suite || "").trim();
  if (explicit) return explicit;
  return String(tool?.access || "").trim() === "atlas" ? "atlas" : "tools";
}

function explicitSurfaceName(tool = {}) {
  return String(tool?.providerSurfaceName || tool?.surfaceName || "").trim();
}

export class ProviderToolRenderer {
  constructor({
    providerName = "generic",
    toolAttachmentMode = null,
    issuedSurface = [],
  } = {}) {
    this.providerName = normalizeProviderName(providerName) || "generic";
    this.toolAttachmentMode = String(toolAttachmentMode || "").trim() || null;
    this.issuedTools = issuedToolsFrom(issuedSurface).map((tool) => ({ ...tool }));
  }

  render(reference) {
    const { suite, canonicalName } = normalizeToolReference(reference);
    const tool = this.issuedTools.find((candidate) => (
      canonicalNameFor(candidate) === canonicalName
      && suiteFor(candidate) === suite
    ));
    if (!tool) {
      const error = new Error(
        `Tool ${suite}.${canonicalName} was not issued for provider ${this.providerName}`,
      );
      error.code = "PROVIDER_TOOL_NOT_ISSUED";
      throw error;
    }

    const explicit = explicitSurfaceName(tool);
    if (explicit) return explicit;

    // Generic contracts use their canonical names as the callable surface.
    // Every provider-specific contract, including function attachment, must
    // carry an explicit name projected from the definitions issued that run.
    if (this.providerName === "generic") return canonicalName;

    const error = new Error(
      `Tool ${suite}.${canonicalName} has no resolved callable name for provider ${this.providerName}`,
    );
    error.code = "PROVIDER_TOOL_NAME_UNRESOLVED";
    throw error;
  }

  tryRender(reference) {
    try {
      return this.render(reference);
    } catch (error) {
      if (["PROVIDER_TOOL_NOT_ISSUED", "PROVIDER_TOOL_NAME_UNRESOLVED"].includes(error?.code)) {
        return null;
      }
      throw error;
    }
  }

  renderIssued(tool = {}) {
    const canonicalName = canonicalNameFor(tool);
    if (!canonicalName) {
      throw new TypeError("Issued tool rendering requires a canonical name");
    }
    return this.render({ suite: suiteFor(tool), canonicalName });
  }

  tryRenderIssued(tool = {}) {
    try {
      return this.renderIssued(tool);
    } catch (error) {
      if (
        error instanceof TypeError
        || ["PROVIDER_TOOL_NOT_ISSUED", "PROVIDER_TOOL_NAME_UNRESOLVED"].includes(error?.code)
      ) {
        return null;
      }
      throw error;
    }
  }
}
