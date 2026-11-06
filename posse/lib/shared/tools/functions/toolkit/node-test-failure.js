import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// A browser bootstrap failure is a missing verification prerequisite, even
// when a repository script launches Playwright through a package manager.
const BROWSER_LAUNCH_FAILURE = /browserType\.launch: Executable doesn't exist|browserType\.launch:[^\n]*Host system is missing dependencies/u;
export function missingBrowserTestRuntime(output) {
  return BROWSER_LAUNCH_FAILURE.test(String(output || ""));
}

// Runner failure listings print one record per failed test with that test's
// own error, however often the error repeats elsewhere (Vitest's tree,
// Playwright retries). Headers count from the listing's start line onward.
const FAILURE_LISTINGS = [
  // node:test spec recap: `✖ title`, a suite carries its failed hook's error.
  { start: /^✖ failing tests:$/u, header: /^✖ /u },
  // node:test TAP: `not ok N - title` for every test and suite. A record
  // ends with its YAML block; `#` lines after it are other tests' output.
  { start: /^TAP version \d+$/u, header: /^\s*not ok \d+ - /u, end: /^\s*\.\.\.$/u },
  // Vitest: tests that threw one shared error print adjacent ` FAIL ` headers.
  { start: /^⎯+ (?:Failed (?:Tests|Suites) \d+|Unhandled Errors) ⎯+$/u, header: /^\s*FAIL\s+\S|^⎯+ Unhandled (?:Rejection|Error) ⎯+$/u },
  // Playwright Test: `  1) [project] › file › title`, retries under one number.
  { start: null, header: /^ {2}\d+\) \S.* › /u },
];
// Tests cancelled with their parent, and suites that only aggregate failed
// subtests, carry no error of their own.
const COLLATERAL_FAILURE = /test did not finish before its parent and was cancelled|failureType: '(?:cancelledByParent|subtestsFailed)'/u;
// node:test lists a test file whose process exited early as `'test failed'`;
// its cause is the stderr that file printed outside the listing.
const FILE_PROCESS_FAILURE = /^\s*(?:error: )?'test failed'\s*$/mu;

function failureListing(lines) {
  const headers = new Map();
  for (const { start, header, end } of FAILURE_LISTINGS) {
    const first = start ? lines.findIndex((line) => start.test(line)) : -1;
    if (start && first < 0) continue;
    lines.forEach((line, index) => { if (index > first && header.test(line)) headers.set(index, end); });
  }
  if (headers.size === 0) return null;
  const starts = [...headers.keys()].sort((a, b) => a - b);
  const records = [];
  const listed = new Set();
  let tests = 0;
  starts.forEach((start, index) => {
    tests += 1;
    const next = starts[index + 1] ?? lines.length;
    const end = headers.get(start);
    const close = end ? lines.findIndex((line, at) => at > start && at < next && end.test(line)) : -1;
    const stop = close < 0 ? next : close + 1;
    const body = lines.slice(start + 1, stop).join("\n");
    // Vitest prints one error under every header that shares it.
    if (!body.trim() && index < starts.length - 1) return;
    for (let at = start; at < stop; at += 1) listed.add(at);
    records.push({ tests, body });
    tests = 0;
  });
  return { records, listed };
}

// A run whose only failures are browser launches ran no test; a run that also
// passed tests, or failed any test for another reason, has product evidence
// the missing browser must not hide. Without a recognised failure listing,
// launch lines are compared with the runner's failed-test summary.
export function browserLaunchFailuresExplainTestOutput(output, executionCounts = null) {
  const text = String(output || "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const launchFailures = lines.filter((line) => BROWSER_LAUNCH_FAILURE.test(line)).length;
  if (launchFailures === 0) return false;
  const counts = (pattern) => [...text.matchAll(pattern)].map((match) => Number(match[1]));
  if ([...counts(/(?:^|[^\w.])(\d+)\s+(?:passed|passing)\b/gmu), ...counts(/^\s*(?:#|ℹ) pass\s+(\d+)\s*$/gm)].some((count) => count > 0)) return false;
  const failed = [...counts(/(?:^|[^\w.])(\d+)\s+(?:failed|failing)\b/gmu), ...counts(/^\s*(?:#|ℹ) fail\s+(\d+)\s*$/gm)];
  const listing = failureListing(lines);
  if (listing) {
    // A listing missing summarised failures (truncated output) proves nothing.
    if (listing.records.reduce((sum, record) => sum + record.tests, 0) < Math.max(0, ...failed)) return false;
    let crashedFiles = 0;
    for (const { body } of listing.records) {
      // Playwright groups every attempt under one test header. Each attempt
      // must be explained: a missing browser on retry cannot erase an earlier
      // assertion failure (nor can an earlier launch explain a later failure).
      const attempts = body.split(/^\s+Retry #\d+ [─⎯-]+\s*$/mu);
      for (const attempt of attempts) {
        if (BROWSER_LAUNCH_FAILURE.test(attempt) || COLLATERAL_FAILURE.test(attempt)) continue;
        if (!FILE_PROCESS_FAILURE.test(attempt)) return false;
        crashedFiles += 1;
      }
    }
    // Each crashed file needs its own launch failure outside the listing.
    return crashedFiles <= lines.filter((line, index) => !listing.listed.has(index) && BROWSER_LAUNCH_FAILURE.test(line)).length;
  }
  if (executionCounts && executionCounts.total - executionCounts.skipped > launchFailures) return false;
  return failed.length === 0 || Math.max(...failed) <= launchFailures;
}

// Missing external packages are verification prerequisites; missing relative
// application modules remain product failures.
export function missingNodeTestDependency(output) {
  const match = /(?:Cannot find (?:module|package)|Failed to resolve import) ['"]([^'"]+)['"]/.exec(String(output || ""));
  const name = match?.[1];
  if (!name || /^(?:[./#]|[A-Za-z]:|file:|node:|@\/)/.test(name)) return null;
  return name;
}

// Babel resolves configured presets/plugins before Jest can collect tests.
// Require every failed suite to have this bootstrap failure and zero executed
// tests, so a missing transformer cannot hide a separate product failure.
export function missingJestTransformDependency(output) {
  const text = String(output || "").replace(/\x1b\[[0-9;]*m/g, "");
  if (!/^Tests:\s+0 total\s*$/mu.test(text)) return null;
  const failed = /^Test Suites:\s+(\d+) failed\b/mu.exec(text);
  const suites = text.split(/^FAIL\s+[^\n]+\n/gmu).slice(1);
  if (!failed || suites.length !== Number(failed[1])) return null;
  const dependencies = suites.map((suite) => {
    if (!/[@]babel[\\/]core[\\/]lib[\\/]config[\\/]files[\\/]plugins\.js/u.test(suite)) return null;
    return missingNodeTestDependency(suite);
  });
  return dependencies.length && dependencies.every(Boolean) ? dependencies[0] : null;
}

// Typecheck can run using an ancestor's tools while a newly declared package
// is still absent. An installed package's bad subpath/types and undeclared
// imports remain product failures; installing dependencies cannot fix them.
export function missingDeclaredNodeDependency(output, projectRoot) {
  if (!projectRoot) return null;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")); }
  catch { return null; }
  const declared = { ...manifest.dependencies, ...manifest.devDependencies,
    ...manifest.optionalDependencies, ...manifest.peerDependencies };
  const require = createRequire(path.resolve(projectRoot, "package.json"));
  for (const line of String(output || "").split("\n")) {
    const specifier = missingNodeTestDependency(line);
    if (!specifier) continue;
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    if (!Object.hasOwn(declared, name)) continue;
    const installed = (require.resolve.paths(name) || [])
      .some((root) => fs.existsSync(path.join(root, name, "package.json")));
    if (!installed) return name;
  }
  return null;
}
