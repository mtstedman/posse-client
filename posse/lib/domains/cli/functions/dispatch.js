export async function dispatchCommand(command, handlers) {
  const handler = handlers?.[command];
  if (typeof handler !== "function") {
    return { handled: false, result: undefined };
  }
  return { handled: true, result: await handler() };
}
