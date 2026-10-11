import { projectAgentToolDefinition } from "./agent-schema.js";

const OPENAI_COMPATIBLE_SCHEMA_PROVIDERS = new Set(["openai", "grok"]);
const UNSUPPORTED_COMPOSITION_KEYS = new Set([
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
]);

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function projectLocalToolDefinition(tool) {
  if (tool?.name !== "edit_file") return tool;
  const parameters = isObject(tool.parameters) ? tool.parameters : {};
  const { edits: _edits, ...properties } = isObject(parameters.properties) ? parameters.properties : {};
  return {
    ...tool,
    description: "Edit one allowed file with one exact, line, pattern, insertion, append, JSON, or executable mode.",
    parameters: {
      ...parameters,
      properties,
      oneOf: Array.isArray(parameters.oneOf)
        ? parameters.oneOf.filter((branch) => !(Array.isArray(branch.required) && branch.required.includes("edits")))
        : parameters.oneOf,
    },
  };
}

function uniqueSchemas(schemas) {
  const seen = new Set();
  return schemas.filter((schema) => {
    const key = JSON.stringify(schema);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function combinedPropertySchema(schemas) {
  const nonEmpty = schemas.filter((schema) => !isObject(schema) || Object.keys(schema).length > 0);
  const unique = uniqueSchemas(nonEmpty.length > 0 ? nonEmpty : schemas);
  if (unique.length === 1) return unique[0];
  return { anyOf: unique };
}

function flattenRootUnion(schema, alternatives) {
  const baseProperties = isObject(schema.properties) ? schema.properties : {};
  const propertyVariants = new Map(
    Object.entries(baseProperties).map(([name, property]) => [name, [property]]),
  );
  const branchRequired = [];
  let closesObject = schema.additionalProperties === false;
  for (const alternative of alternatives) {
    if (!isObject(alternative)) continue;
    for (const [name, property] of Object.entries(alternative.properties || {})) {
      const variants = propertyVariants.get(name) || [];
      variants.push(property);
      propertyVariants.set(name, variants);
    }
    branchRequired.push(new Set([
      ...(Array.isArray(schema.required) ? schema.required : []),
      ...(Array.isArray(alternative.required) ? alternative.required : []),
    ]));
    closesObject ||= alternative.additionalProperties === false;
  }
  const required = branchRequired.length > 0
    ? [...branchRequired[0]].filter((name) => branchRequired.every((set) => set.has(name)))
    : [...(schema.required || [])];
  return {
    ...schema,
    type: "object",
    properties: Object.fromEntries(
      [...propertyVariants].map(([name, variants]) => [
        name,
        combinedPropertySchema(variants.map((variant) => projectOpenAiCompatibleSchema(variant))),
      ]),
    ),
    required,
    ...(closesObject ? { additionalProperties: false } : {}),
  };
}

function projectOpenAiCompatibleSchema(value, { root = false } = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => projectOpenAiCompatibleSchema(item));
  }
  if (!isObject(value)) return value;

  const alternatives = Array.isArray(value.oneOf) && value.oneOf.length > 0
    ? value.oneOf
    : (Array.isArray(value.anyOf) && value.anyOf.length > 0 ? value.anyOf : null);
  const source = root && alternatives ? flattenRootUnion(value, alternatives) : value;
  const projected = {};
  for (const [key, child] of Object.entries(source)) {
    if (UNSUPPORTED_COMPOSITION_KEYS.has(key)) continue;
    if (root && (key === "oneOf" || key === "anyOf")) continue;
    if (key === "oneOf") {
      projected.anyOf = child.map((variant) => projectOpenAiCompatibleSchema(variant));
      continue;
    }
    projected[key] = projectOpenAiCompatibleSchema(child);
  }
  return projected;
}

export function projectProviderToolDefinition(definition = {}, providerName = "generic") {
  const projected = projectAgentToolDefinition(definition);
  const provider = String(providerName || "").trim().toLowerCase();
  if (provider === "posse-local") return projectLocalToolDefinition(projected);
  if (!OPENAI_COMPATIBLE_SCHEMA_PROVIDERS.has(provider)) return projected;
  const result = { ...projected };
  for (const key of ["parameters", "inputSchema", "input_schema"]) {
    if (isObject(projected[key])) result[key] = projectOpenAiCompatibleSchema(projected[key], { root: true });
  }
  return result;
}
