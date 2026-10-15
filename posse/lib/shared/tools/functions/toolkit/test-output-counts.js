// Parse runner summaries, never assertions about success in arbitrary prose.
// Unknown formats retain their exit-code result with explicitly unknown counts.
export function testExecutionCounts(output = "") {
  const text = String(output).replace(/\x1b\[[0-9;]*m/g, "").replace(/\r\n?/g, "\n");
  const node = [...text.matchAll(/^\s*(?:#|ℹ) tests\s+(\d+)\s*$/gm)];
  if (node.length) {
    return {
      total: node.reduce((sum, match) => sum + Number(match[1]), 0),
      skipped: [...text.matchAll(/^\s*(?:#|ℹ) (?:skipped|todo)\s+(\d+)\s*$/gm)]
        .reduce((sum, match) => sum + Number(match[1]), 0),
    };
  }
  const jest = [...text.matchAll(/^\s*Tests:\s*(.*?)(\d+) total\s*$/gm)];
  if (jest.length) return {
    total: jest.reduce((sum, match) => sum + Number(match[2]), 0),
    skipped: jest.reduce((sum, match) => sum + [...match[1].matchAll(/(\d+) (?:skipped|todo)/g)]
      .reduce((count, skip) => count + Number(skip[1]), 0), 0),
  };
  const cargo = [...text.matchAll(/^\s*test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/gm)];
  if (cargo.length) return {
    total: cargo.reduce((sum, match) => sum + Number(match[1]) + Number(match[2]) + Number(match[3]), 0),
    skipped: cargo.reduce((sum, match) => sum + Number(match[3]), 0),
  };
  const php = /\bTests:\s*(\d+),\s*Assertions:\s*\d+/.exec(text);
  if (php) return { total: Number(php[1]), skipped: Number(/Skipped:\s*(\d+)/.exec(text)?.[1] || 0) };
  const phpOk = /^\s*OK \((\d+) tests?, \d+ assertions?\)\s*$/m.exec(text);
  if (phpOk) return { total: Number(phpOk[1]), skipped: 0 };
  // pytest's closing line: "2 failed, 13 passed, 1 skipped in 0.50s".
  const pytest = [...text.matchAll(/^[=\s]*((?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?|rerun)(?:, )?)+) in \d+(?:\.\d+)?s\b.*$/gm)].at(-1);
  if (pytest) {
    const count = (pattern) => [...pytest[1].matchAll(pattern)].reduce((sum, match) => sum + Number(match[1]), 0);
    return {
      total: count(/(\d+) (?:passed|failed|errors?|skipped|xfailed|xpassed)\b/g),
      skipped: count(/(\d+) skipped\b/g),
    };
  }
  // Python unittest: "Ran 4 tests in 0.01s", a blank line, then the outcome,
  // e.g. "FAILED (failures=1, errors=1, skipped=1)" or "OK (skipped=1)".
  const unittest = [...text.matchAll(/^Ran (\d+) tests? in \d+(?:\.\d+)?s\n\n(?:OK|FAILED|NO TESTS RAN)(?: \(([^)\n]*)\))?[ \t]*$/gm)];
  if (unittest.length) return {
    total: unittest.reduce((sum, match) => sum + Number(match[1]), 0),
    skipped: unittest.reduce((sum, match) => sum + Number(/\bskipped=(\d+)/.exec(match[2] || "")?.[1] || 0), 0),
  };
  // Mocha's spec summary: "3 passing (12ms)", then "1 failing", "1 pending".
  const mochaPassing = [...text.matchAll(/^\s*(\d+) passing \(\d+(?:\.\d+)?m?s\)\s*$/gm)];
  if (mochaPassing.length) {
    const count = (pattern) => [...text.matchAll(pattern)].reduce((sum, match) => sum + Number(match[1]), 0);
    const pending = count(/^\s*(\d+) pending\s*$/gm);
    return {
      total: mochaPassing.reduce((sum, match) => sum + Number(match[1]), 0) + count(/^\s*(\d+) failing\s*$/gm) + pending,
      skipped: pending,
    };
  }
  // Vitest: "Tests  1 failed | 2 passed | 1 skipped (4)", never "Test Files".
  const vitest = [...text.matchAll(/^\s*Tests\s+(\d+ (?:passed|failed|skipped|todo)\b[^()\n]*?)\s*\((\d+)\)\s*$/gm)];
  if (vitest.length) return {
    total: vitest.reduce((sum, match) => sum + Number(match[2]), 0),
    skipped: vitest.reduce((sum, match) => sum + [...match[1].matchAll(/(\d+) (?:skipped|todo)\b/g)]
      .reduce((count, skip) => count + Number(skip[1]), 0), 0),
  };
  // RSpec: "5 examples, 1 failure, 2 pending".
  const rspec = [...text.matchAll(/^(\d+) examples?, \d+ failures?(?:, (\d+) pending)?\b/gm)];
  if (rspec.length) return {
    total: rspec.reduce((sum, match) => sum + Number(match[1]), 0),
    skipped: rspec.reduce((sum, match) => sum + Number(match[2] || 0), 0),
  };
  // Minitest: "3 runs, 5 assertions, 1 failures, 0 errors, 1 skips".
  const minitest = [...text.matchAll(/^(\d+) runs?, \d+ assertions?, \d+ failures?, \d+ errors?, (\d+) skips?\b/gm)];
  if (minitest.length) return {
    total: minitest.reduce((sum, match) => sum + Number(match[1]), 0),
    skipped: minitest.reduce((sum, match) => sum + Number(match[2]), 0),
  };
  // `go test -v` reports each case, subtests included, as --- PASS/FAIL/SKIP.
  const goCases = [...text.matchAll(/^\s*--- (PASS|FAIL|SKIP): /gm)];
  if (goCases.length) return {
    total: goCases.length,
    skipped: goCases.filter((match) => match[1] === "SKIP").length,
  };
  // Go's package summaries without -v do not report case counts. A testless
  // package cannot erase evidence from another package in `go test ./...`,
  // but when every package reports `[no tests to run]`, none ran.
  const goPackages = text.match(/^\s*(?:ok|FAIL)\s+\S+.*$/gm);
  if (goPackages) {
    return goPackages.every((line) => /^\s*ok\s+\S+\s.*\[no tests to run\]\s*$/.test(line)) ? { total: 0, skipped: 0 } : null;
  }
  if (/^\s*(?:No tests (?:executed|found|collected)[.!]?|No test(?: files|s) found, exiting with code 0|no tests ran in .+|\?\s+\S+\s+\[no test files\])\s*$/mi.test(text)) {
    return { total: 0, skipped: 0 };
  }
  if (/^\s*(?:SKIP(?:PED)?\b|1\.\.0\s+#\s*SKIP)/mi.test(text)) return { total: 0, skipped: 0 };
  return null;
}
