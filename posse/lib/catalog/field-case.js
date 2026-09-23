// One field-name convention on the agent surface: snake_case keys everywhere,
// so a reader never has to know which family a field came from. Enum VALUES
// (granularity "fileWindow", kinds, modes) stay as the native contract defines
// them; only keys are converted. Internal envelopes keep their own names —
// conversion happens at the agent boundary, in both directions.
const ACRONYM_TAIL = /([a-z0-9])([A-Z])/g;

export function camelToSnakeKey(key = "") {
  const name = String(key);
  if (!/[A-Z]/.test(name)) return name;
  return name.replace(ACRONYM_TAIL, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase();
}

export function snakeToCamelKey(key = "") {
  const name = String(key);
  if (!name.includes("_")) return name;
  return name.replace(/_([a-z0-9])/g, (_, char) => String(char).toUpperCase());
}
