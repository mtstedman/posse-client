export function assertTestContext(helperName = "test-only helper") {
  if (process.env.NODE_TEST_CONTEXT) return;
  throw new Error(`${helperName} is test-only and may only run under node --test`);
}
