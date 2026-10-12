// @ts-check
// Keep Set/Map iteration, membership and instanceof contracts while preventing
// accidental mutation of catalog policy. Consumers needing a working copy must
// construct a new Set/Map. These guards are not an untrusted-code sandbox.
function lockCollection(collection, mutators) {
  for (const method of mutators) {
    Object.defineProperty(collection, method, {
      value() { throw new TypeError("catalog collections are read-only; copy before changing"); },
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(collection);
}

export function readonlySet(values) {
  return lockCollection(new Set(values), ["add", "delete", "clear"]);
}

export function readonlyMap(entries) {
  return lockCollection(new Map(entries), ["set", "delete", "clear"]);
}
