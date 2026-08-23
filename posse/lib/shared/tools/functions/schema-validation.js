import Ajv from "ajv";

const validator = new Ajv({
  allErrors: true,
  allowUnionTypes: true,
  strictSchema: true,
  strictTypes: false,
  strictRequired: false,
});

validator.addKeyword({
  keyword: "internalOnly",
  schemaType: "boolean",
  valid: true,
});

const compiledSchemas = new WeakMap();

function schemaForDefinition(definition = {}) {
  return definition?.parameters
    || definition?.inputSchema
    || definition?.input_schema
    || { type: "object" };
}

function compiledValidator(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError("Tool argument schemas must be JSON Schema objects");
  }
  let compiled = compiledSchemas.get(schema);
  if (!compiled) {
    compiled = validator.compile(schema);
    compiledSchemas.set(schema, compiled);
  }
  return compiled;
}

function displayPath(instancePath = "", missingProperty = null) {
  const segments = String(instancePath || "")
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (missingProperty) segments.push(String(missingProperty));
  return segments.length > 0
    ? `arguments.${segments.map((segment) => (
      /^[A-Za-z_$][\w$]*$/.test(segment)
        ? segment
        : (/^\d+$/.test(segment) ? `[${segment}]` : `[${JSON.stringify(segment)}]`)
    )).join(".").replaceAll(".[", "[")}`
    : "arguments";
}

export function formatSchemaValidationError(error = {}) {
  const missing = error?.keyword === "required" ? error?.params?.missingProperty : null;
  const path = displayPath(error?.instancePath, missing);
  if (error?.keyword === "required") return `${path} is required`;
  if (error?.keyword === "additionalProperties") {
    return `${displayPath(error?.instancePath, error?.params?.additionalProperty)} is not allowed`;
  }
  if (error?.keyword === "type") {
    const type = String(error?.params?.type || "value");
    const article = /^[aeiou]/i.test(type) ? "an" : "a";
    return `${path} must be ${article} ${type}`;
  }
  return `${path} ${String(error?.message || "is invalid")}`;
}

export function validateToolArguments(definition, args) {
  const validate = compiledValidator(schemaForDefinition(definition));
  const ok = validate(args);
  const errors = ok ? [] : (validate.errors || []).map((error) => ({ ...error, params: { ...(error.params || {}) } }));
  return {
    ok: !!ok,
    errors,
    message: errors.length > 0 ? formatSchemaValidationError(errors[0]) : null,
  };
}
