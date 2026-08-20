// Agent-facing tool schemas are a projection of the canonical execution
// schema. A property marked `internalOnly: true` remains available to internal
// callers and validators but is omitted from every provider-facing schema.

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
