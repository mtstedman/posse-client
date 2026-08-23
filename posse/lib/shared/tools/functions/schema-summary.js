function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeBranch(left = {}, right = {}) {
  const properties = { ...(isObject(left.properties) ? left.properties : {}) };
  for (const [name, schema] of Object.entries(isObject(right.properties) ? right.properties : {})) {
    const current = properties[name];
    properties[name] = isObject(schema) && Object.keys(schema).length === 0 && isObject(current)
      ? current
      : schema;
  }
  return {
    properties,
    required: [...new Set([
      ...(Array.isArray(left.required) ? left.required : []),
      ...(Array.isArray(right.required) ? right.required : []),
    ])],
  };
}

function crossMerge(left, right) {
  return left.flatMap((base) => right.map((addition) => mergeBranch(base, addition)));
}

function conditionalBranches(schema) {
  if (!isObject(schema) || !schema.if) return null;
  const whenTrue = expandSchemaBranches(schema.then || {});
  const whenFalse = schema.else ? expandSchemaBranches(schema.else) : [{}];
  return [...whenTrue, ...whenFalse];
}

export function expandSchemaBranches(schema = {}) {
  if (!isObject(schema)) return [{}];
  const base = {
    properties: isObject(schema.properties) ? schema.properties : {},
    required: Array.isArray(schema.required) ? schema.required : [],
  };
  const alternatives = Array.isArray(schema.oneOf) && schema.oneOf.length > 0
    ? schema.oneOf
    : (Array.isArray(schema.anyOf) && schema.anyOf.length > 0 ? schema.anyOf : null);
  let branches = alternatives
    ? alternatives.flatMap((alternative) => expandSchemaBranches(alternative).map((branch) => mergeBranch(base, branch)))
    : [base];

  const directConditional = conditionalBranches(schema);
  if (directConditional) branches = crossMerge(branches, directConditional);

  for (const conjunct of Array.isArray(schema.allOf) ? schema.allOf : []) {
    const variants = conditionalBranches(conjunct) || expandSchemaBranches(conjunct);
    branches = crossMerge(branches, variants);
  }
  return branches;
}
