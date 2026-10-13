import { readonlySet } from "./readonly-collections.js";

// Flags rejected in planner commands and their declared package scripts.
export const MUTATING_TEST_FLAGS = readonlySet([
  "-u", "--accept", "--bless", "--coverage", "--cov", "--fix", "--record",
  "--basetemp", "--blockprofile", "--coverprofile", "--cpuprofile", "--html",
  "--cov-report", "--junitxml", "--memprofile", "--mutexprofile", "--out-dir", "--outdir",
  "--output", "--outputdir", "--report-log", "--result-log",
  "--self-contained-html", "--snapshot-update", "--target-dir", "--test-reporter-destination",
  "--test-update-snapshots", "--trace", "--tsbuildinfofile", "--update", "--update-golden",
  "--update-snapshot", "--update-snapshots", "--updatesnapshot", "--write",
]);
export const INTERACTIVE_TEST_FLAGS = readonlySet([
  "--inspect", "--inspect-brk", "--open", "--ui", "--watch", "--watchall", "--watch-all",
]);
