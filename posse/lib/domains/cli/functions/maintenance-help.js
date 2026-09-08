// Keep maintenance help available even when npm dependencies are missing.

export function renderDoctorHelp({ log, colors }) {
  log(`
  ${colors.bold}posse doctor${colors.reset}

  Repair dependency/runtime requirements for the current repo.

  Usage:
    posse doctor
    posse doctor --dry-run
    posse doctor --json
    posse doctor --adopt-node-install

  Each package-manager command is capped at 30 minutes and Jina download/deploy
  at 2 hours, so an unhealthy child process cannot hang doctor indefinitely.
  --adopt-node-install reuses a complete existing Posse node_modules tree.
`);
}

export function renderUpdateHelp({ log, colors }) {
  log(`
  ${colors.bold}posse update${colors.reset}

  Fast-forward the local Posse client checkout, show what came in, and refresh
  runtime dependencies, current native binaries, and Jina (posse doctor).

  Usage:
    posse update
    posse update --dry-run     check for updates without touching the checkout
    posse update --json        machine-readable result
    posse update --branch main

  The update is fast-forward only and refuses local tracked edits.
  Each dependency command is capped at 30 minutes and Jina deployment at 2 hours.
`);
}
