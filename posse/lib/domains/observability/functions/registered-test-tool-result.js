const REGISTERED_TEST_TOOLS = new Set(["create_test", "run_test", "run_test_suite"]);
const MAX_LABEL_CHARS = 160;

function label(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS);
}

function parseResult(resultText) {
  if (typeof resultText !== "string" || !resultText.trimStart().startsWith("{")) return null;
  try {
    const value = JSON.parse(resultText);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function identity(value, fallback = "") {
  if (!value || typeof value !== "object") return label(fallback);
  if (value.name) return label(value.name);
  if (value.slug) return label(value.slug);
  if (value.id != null) return `#${value.id}`;
  return label(fallback);
}

function inputSelector(input = {}) {
  const suite = label(input.suite || (input.suite_id != null ? `suite #${input.suite_id}` : ""));
  const test = label(input.test || (input.test_id != null ? `test #${input.test_id}` : input.name || ""));
  return [suite, test].filter(Boolean).join(" / ") || "unresolved test";
}

function resultSelector(result = {}, input = {}) {
  const suite = identity(result.suite, input.suite || (input.suite_id != null ? `suite #${input.suite_id}` : ""));
  const test = identity(result.test, input.test || (input.test_id != null ? `test #${input.test_id}` : input.name || ""));
  return [suite, test].filter(Boolean).join(" / ") || inputSelector(input);
}

function batchSelectors(payload, input) {
  const inputs = Array.isArray(input?.tests) ? input.tests : [];
  return (Array.isArray(payload?.results) ? payload.results : []).map((result, index) =>
    resultSelector(result, inputs[result?.input_index ?? index] || {}));
}

function compactSelectors(values, max = 3) {
  const labels = values.map((value) => String(value || "").trim()).filter(Boolean);
  if (labels.length <= max) return labels.join("; ");
  return `${labels.slice(0, max).join("; ")}; +${labels.length - max}`;
}

function firstFailureMessage(payload) {
  const direct = payload?.failure?.message;
  if (direct) return String(direct);
  for (const result of payload?.results || []) {
    if (result?.failure?.message) return String(result.failure.message);
  }
  for (const failure of payload?.failures || []) {
    if (failure?.failure?.message) return String(failure.failure.message);
  }
  return null;
}

function countResults(payload, results) {
  const total = Number.isFinite(payload?.total) ? Number(payload.total) : results.length;
  const passed = Number.isFinite(payload?.passed)
    ? Number(payload.passed)
    : results.filter((result) => result?.ok === true).length;
  return { total, passed, failed: Math.max(0, total - passed) };
}

function createTestSummary(payload, input) {
  if (Array.isArray(payload.results)) {
    const counts = countResults(payload, payload.results);
    const targets = compactSelectors(batchSelectors(payload, input));
    return {
      summary: `CreateTest: ${counts.passed}/${counts.total} PASS${counts.failed ? " · failed candidates not added" : ""}${targets ? ` — ${targets}` : ""}`,
      detail: { kind: "create_test", ...counts, targets: batchSelectors(payload, input) },
    };
  }
  const target = resultSelector(payload, input);
  const passed = payload.ok === true && payload.registered === true && payload.passed !== false;
  const action = payload.updated ? "updated" : "added";
  return {
    summary: `CreateTest: ${target} — ${passed ? `PASS (${action})` : "FAIL (not added)"}`,
    detail: { kind: "create_test", total: 1, passed: passed ? 1 : 0, failed: passed ? 0 : 1, targets: [target] },
  };
}

function runTestSummary(payload, input) {
  if (Array.isArray(payload.results)) {
    const counts = countResults(payload, payload.results);
    const targets = batchSelectors(payload, input);
    return {
      summary: `RunTest: ${counts.passed}/${counts.total} PASS${targets.length ? ` — ${compactSelectors(targets)}` : ""}`,
      detail: { kind: "run_test", ...counts, targets },
    };
  }
  const target = resultSelector(payload, input);
  const ran = !!payload.test && typeof payload.passed === "boolean";
  return {
    summary: `RunTest: ${target} — ${ran ? (payload.passed ? "PASS" : "FAIL") : "NOT RUN"}`,
    detail: { kind: "run_test", total: ran ? 1 : 0, passed: payload.passed ? 1 : 0, failed: ran && !payload.passed ? 1 : 0, targets: [target] },
  };
}

function runSuiteSummary(payload, input) {
  const suite = identity(payload.suite, input.suite || (input.suite_id != null ? `suite #${input.suite_id}` : "unresolved suite"));
  const tests = Array.isArray(payload.tests) ? payload.tests : [];
  const passed = tests.filter((test) => test?.ok === true).length;
  const failed = tests.filter((test) => test?.ok === false).length;
  const status = tests.length === 0 ? "NO TESTS" : (failed === 0 ? "PASS" : "FAIL");
  return {
    summary: `RunSuite: ${suite} — ${status} (${passed}/${tests.length})`,
    detail: {
      kind: "run_test_suite",
      suite,
      total: tests.length,
      passed,
      failed,
      targets: tests.map((test) => String(test?.name || `test #${test?.id ?? "?"}`)),
    },
  };
}

export function registeredTestToolResultObservation({ tool, input = {}, resultText = "" } = {}) {
  const name = String(tool || "").trim().toLowerCase().replace(/^tools[._-]/, "");
  if (!REGISTERED_TEST_TOOLS.has(name)) return null;
  const payload = parseResult(resultText);
  if (!payload) return null;
  const formatted = name === "create_test"
    ? createTestSummary(payload, input)
    : (name === "run_test" ? runTestSummary(payload, input) : runSuiteSummary(payload, input));
  return {
    ...formatted,
    error: firstFailureMessage(payload),
  };
}
