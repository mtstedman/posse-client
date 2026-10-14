// Runtime capabilities are deliberately non-enumerable: they must survive
// option projection without entering logs or serialized native requests.
export function copyProviderOptions(options, overrides = {}) {
  const copy = { ...options, ...overrides };
  for (const key of ["agent", "mcpGate"]) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor) Object.defineProperty(copy, key, descriptor);
  }
  return copy;
}
