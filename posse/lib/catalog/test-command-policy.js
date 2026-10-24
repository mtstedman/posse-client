import { readonlySet } from "./readonly-collections.js";

export const NODE_TEST_VALUE_FLAGS = readonlySet([
  "-r", "--require", "--import", "--loader", "--experimental-loader", "--conditions", "-C",
  "--test-reporter", "--test-name-pattern", "--test-skip-pattern", "--test-timeout",
  "--test-concurrency", "--test-shard", "--input-type",
]);
export const PHP_TEST_VALUE_FLAGS = readonlySet(["-d", "--define", "-c", "--php-ini"]);

// Flags rejected in planner commands and their declared package scripts.
export const MUTATING_TEST_FLAGS = readonlySet([
  "-u", "--accept", "--bless", "--coverage", "--cov", "--fix", "--record",
  "--basetemp", "--blockprofile", "--coverprofile", "--cpuprofile", "--html",
  "--cov-report", "--junitxml", "--memprofile", "--mutexprofile", "--out-dir", "--outdir",
  "--output", "--outputdir", "--outputfile", "--report-log", "--result-log",
  "--self-contained-html", "--snapshot-update", "--target-dir", "--test-reporter-destination",
  "--test-update-snapshots", "--trace", "--tsbuildinfofile", "--update", "--update-golden",
  "--update-snapshot", "--update-snapshots", "--updatesnapshot", "--write",
]);
export const INTERACTIVE_TEST_FLAGS = readonlySet([
  "--inspect", "--inspect-brk", "--open", "--ui", "--watch", "--watchall", "--watch-all",
]);

// Node test runners admitted bare or through npx, pnpm, yarn or bunx, mapped
// to the packages that may provide their bin. A launcher is syntax only:
// verification runs the repository's installed bin and never downloads one.
export const LOCAL_NODE_TEST_RUNNER_PACKAGES = Object.freeze({
  vitest: Object.freeze(["vitest"]),
  jest: Object.freeze(["jest"]),
  mocha: Object.freeze(["mocha"]),
  playwright: Object.freeze(["@playwright/test", "playwright"]),
  tsx: Object.freeze(["tsx"]),
});
// Bare lint and typecheck executables keep their direct spawn; only their
// launcher spellings resolve through the installed package.
export const LAUNCHED_NODE_CHECK_PACKAGES = Object.freeze({
  eslint: Object.freeze(["eslint"]),
  tsc: Object.freeze(["typescript"]),
  "vue-tsc": Object.freeze(["vue-tsc"]),
});

// Interpreter wrappers preserve runner identity; flags still belong to the runner.
export const INTERPRETER_TEST_RUNNERS = Object.freeze({
  php: Object.freeze({ phpunit: "phpunit", "phpunit.phar": "phpunit", pest: "pest" }),
  python: Object.freeze({ pytest: "pytest" }),
  ruby: Object.freeze({ rspec: "rspec", rake: "rake" }),
});
