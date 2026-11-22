// Agent-facing tool schemas are a projection of the canonical execution
// schema. A property marked `internalOnly: true` remains available to internal
// callers and validators but is omitted from every provider-facing schema,
// together with any `anyOf` alternative that requires it.

const SAME_INSTANCE_SCHEMA_KEYS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
]);

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Sort complete tool definitions after provider projection, without mutating
// catalogs or schema arrays. Code-unit ordering is independent of host locale.
export function sortAgentToolDefinitions(definitions = []) {
  return [...definitions].sort((left, right) => {
    const a = String(left?.name ?? left?.function?.name ?? "");
    const b = String(right?.name ?? right?.function?.name ?? "");
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function hiddenPropertiesForInstance(schema) {
  const hidden = new Set();
  if (!isObject(schema)) return hidden;

  if (isObject(schema.properties)) {
    for (const [name, propertySchema] of Object.entries(schema.properties)) {
      if (isObject(propertySchema) && propertySchema.internalOnly === true) hidden.add(name);
    }
  }

  for (const key of SAME_INSTANCE_SCHEMA_KEYS) {
    const value = schema[key];
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      for (const name of hiddenPropertiesForInstance(child)) hidden.add(name);
    }
  }
  if (isObject(schema.dependentSchemas)) {
    for (const child of Object.values(schema.dependentSchemas)) {
      for (const name of hiddenPropertiesForInstance(child)) hidden.add(name);
    }
  }
  if (isObject(schema.dependencies)) {
    for (const child of Object.values(schema.dependencies)) {
      if (!Array.isArray(child)) {
        for (const name of hiddenPropertiesForInstance(child)) hidden.add(name);
      }
    }
  }
  return hidden;
}

function internalConstraintError(path, keyword, names) {
  const fields = [...new Set(names.map(String))].sort().join(", ");
  return new Error(`Agent schema projection cannot hide constrained field(s) ${fields} at ${path}.${keyword}`);
}

function assertNoHiddenNames(values, hidden, path, keyword) {
  const constrained = (Array.isArray(values) ? values : [])
    .filter((name) => hidden.has(String(name)));
  if (constrained.length > 0) throw internalConstraintError(path, keyword, constrained);
}

function requiresHiddenField(alternative, hidden) {
  return isObject(alternative)
    && Array.isArray(alternative.required)
    && alternative.required.some((name) => hidden.has(String(name)));
}

function projectSchemaValue(value, hiddenForInstance = new Set(), path = "$") {
  if (Array.isArray(value)) {
    return value.map((item, index) => projectSchemaValue(item, hiddenForInstance, `${path}[${index}]`));
  }
  if (!isObject(value)) return value;

  const localHidden = new Set([
    ...hiddenForInstance,
    ...hiddenPropertiesForInstance(value),
  ]);
  const projected = {};

  for (const [key, child] of Object.entries(value)) {
    if (key === "internalOnly") continue;

    if (key === "properties" && isObject(child)) {
      projected.properties = Object.fromEntries(
        Object.entries(child)
          .filter(([name, propertySchema]) => (
            !localHidden.has(name)
            && (!isObject(propertySchema) || propertySchema.internalOnly !== true)
          ))
          .map(([name, propertySchema]) => [
            name,
            projectSchemaValue(propertySchema, new Set(), `${path}.properties.${name}`),
          ]),
      );
      continue;
    }

    if (key === "required" && Array.isArray(child)) {
      assertNoHiddenNames(child, localHidden, path, key);
      projected.required = [...child];
      continue;
    }

    if ((key === "dependentRequired" || key === "dependencies") && isObject(child)) {
      projected[key] = Object.fromEntries(
        Object.entries(child)
          .map(([name, dependency]) => [
            name,
            (() => {
              if (localHidden.has(name)) throw internalConstraintError(path, key, [name]);
              if (Array.isArray(dependency)) {
                assertNoHiddenNames(dependency, localHidden, `${path}.${key}.${name}`, "values");
                return [...dependency];
              }
              return projectSchemaValue(dependency, localHidden, `${path}.${key}.${name}`);
            })(),
          ]),
      );
      continue;
    }

    if (key === "dependentSchemas" && isObject(child)) {
      projected.dependentSchemas = Object.fromEntries(
        Object.entries(child).map(([name, dependencySchema]) => {
          if (localHidden.has(name)) throw internalConstraintError(path, key, [name]);
          return [
            name,
            projectSchemaValue(dependencySchema, localHidden, `${path}.dependentSchemas.${name}`),
          ];
        }),
      );
      continue;
    }

    if (key === "anyOf" && Array.isArray(child)) {
      // An alternative that requires a hidden field is one an agent cannot
      // take, so it leaves the projection with that field. Hiding every
      // alternative would leave the rule unsatisfiable, which is an authoring
      // error like any other hidden constraint.
      const reachable = child.filter((alternative) => !requiresHiddenField(alternative, localHidden));
      if (reachable.length === 0 && child.length > 0) {
        throw internalConstraintError(path, key, child.flatMap((alternative) => (
          isObject(alternative) && Array.isArray(alternative.required)
            ? alternative.required.filter((name) => localHidden.has(String(name)))
            : []
        )));
      }
      projected.anyOf = projectSchemaValue(reachable, localHidden, `${path}.anyOf`);
      continue;
    }

    if (SAME_INSTANCE_SCHEMA_KEYS.has(key)) {
      projected[key] = projectSchemaValue(child, localHidden, `${path}.${key}`);
      continue;
    }

    // Child value schemas (`items`, `additionalProperties`, `$defs`, and
    // visible property schemas above) describe a different object instance.
    projected[key] = projectSchemaValue(child, new Set(), `${path}.${key}`);
  }

  return projected;
}

export function projectAgentToolSchema(schema) {
  return projectSchemaValue(schema);
}

function stripSchemaDescriptions(value, propertyMap = false) {
  if (Array.isArray(value)) return value.map((child) => stripSchemaDescriptions(child));
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => propertyMap || key !== "description")
      .map(([key, child]) => [key,
        !propertyMap && ["const", "enum", "default", "examples"].includes(key)
          ? child
          : stripSchemaDescriptions(child, !propertyMap
            && ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key)),
      ]),
  );
}

// Provider-only schema diet. Validation constraints and the authored tool
// description remain intact; only nested input-field prose is omitted.
export function stripAgentSchemaDescriptions(schema) {
  return stripSchemaDescriptions(schema);
}

export function projectAgentToolDefinition(definition = {}) {
  if (!isObject(definition)) return definition;
  const projected = { ...definition };
  for (const key of ["parameters", "inputSchema", "input_schema"]) {
    if (isObject(definition[key])) projected[key] = projectAgentToolSchema(definition[key]);
  }
  if (isObject(definition.function)) {
    projected.function = projectAgentToolDefinition(definition.function);
  }
  return projected;
}

// Characters of an MCP tools/list surface as a provider forwards it to the
// model: each tool's name, description and input schema. The MCP annotations
// (title and behavior hints) are client metadata and are not counted.
export function providerToolSchemaChars(tools = []) {
  return JSON.stringify((Array.isArray(tools) ? tools : []).map((tool) => ({
    name: tool?.name,
    description: tool?.description,
    inputSchema: tool?.inputSchema,
  }))).length;
}
