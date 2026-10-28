// Installed by execution hosts; the queue must not import the git execution
// graph (which itself depends on queue locks and Remote authentication).
let materializer = null;
export function installScopeCreateMaterializer(fn) { materializer = fn; }
export function materializeScopeCreates(cwd, entries, options) {
  if (!cwd || !entries.some((entry) => entry.access === "create")) return [];
  if (!materializer) throw new Error("Scope create execution host is unavailable");
  return materializer(cwd, entries, options);
}
