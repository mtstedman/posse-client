// Missing external packages are verification prerequisites; missing relative
// application modules remain product failures.
export function missingNodeTestDependency(output) {
  const match = /Cannot find (?:module|package) ['"]([^'"]+)['"]/.exec(String(output || ""));
  const name = match?.[1];
  if (!name || /^(?:[./#]|[A-Za-z]:|file:|node:)/.test(name)) return null;
  return name;
}
