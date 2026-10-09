// Parse runner summaries, never assertions about success in arbitrary prose.
// Unknown formats retain their exit-code result with explicitly unknown counts.
export function testExecutionCounts(output = "") {
  const text = String(output).replace(/\x1b\[[0-9;]*m/g, "");
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
  // Go's package summaries do not report case counts. A testless package
  // cannot erase evidence from another package in the same `go test ./...`.
  if (/^\s*(?:ok|FAIL)\s+\S+|^\s*--- (?:PASS|FAIL|SKIP):/m.test(text)) return null;
  if (/^\s*(?:No tests (?:executed|found|collected)[.!]?|No tests found, exiting with code 0|no tests ran in .+|\?\s+\S+\s+\[no test files\])\s*$/mi.test(text)) {
    return { total: 0, skipped: 0 };
  }
  if (/^\s*(?:SKIP(?:PED)?\b|1\.\.0\s+#\s*SKIP)/mi.test(text)) return { total: 0, skipped: 0 };
  return null;
}
