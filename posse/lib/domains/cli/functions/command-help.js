import { findCommandOnPath } from "../../../shared/platform/functions/command-launch.js";
import { C } from "../../../shared/format/functions/colors.js";
import { REQUEST_KIND_CHOICES, INTAKE_TERMINAL_OUTPUTS } from "../../../catalog/intake.js";
import { WORK_ITEM_MODES } from "../../../catalog/work-item.js";
import { getCatalogRuntimeFallbackInt } from "../../settings/functions/catalog.js";
import { getRuntimeDbPath } from "../../runtime/functions/paths.js";
import { atlasV2UsageSummary } from "./atlas-v2-help.js";

// Command help belongs to the CLI presentation surface. Keep it independent
// of application startup so help can render before repository initialization.

function posseAliasDiagnostic() {
  if (findCommandOnPath("posse") !== null) return "";
  if (findCommandOnPath("claude-org") === null) return "";
  return `  ${C.yellow}Alias notice:${C.reset} legacy command ${C.cyan}claude-org${C.reset} is on PATH, but ${C.cyan}posse${C.reset} is not. Re-run the installer or npm link this package to add the alias.\n`;
}

const COMMAND_USAGE = {
  add: () => {
    console.log(`\n  Usage: posse add "description of what you want built"`);
    const intents = REQUEST_KIND_CHOICES.map((choice) => choice.value).join("|");
    const hotkeys = REQUEST_KIND_CHOICES.map((choice) => choice.aliases[0]).join(",");
    console.log(`  ${C.dim}Optional: --mode ${WORK_ITEM_MODES.join("|")} --oneshot --intent ${intents} (hotkeys ok: ${hotkeys}) --output ${INTAKE_TERMINAL_OUTPUTS.join("|")} --files LIST --constraints LIST${C.reset}\n`);
  },
  run: () => {
    console.log(`\n  Usage: posse run [flags]`);
    console.log(`  Execute all pending jobs (scheduler + worker loop).\n`);
    console.log(`    ${C.cyan}--concurrency N${C.reset}     Run N workers in parallel`);
    console.log(`    ${C.cyan}--auto-approve${C.reset}      Dev won't pause for tool permission prompts`);
    console.log(`    ${C.cyan}--scope-mode MODE${C.reset}   File-scope approvals: default or auto (this run only)`);
    console.log(`    ${C.cyan}--auto-merge${C.reset} / ${C.cyan}--no-auto-merge${C.reset}  Merge (or don't) completed WI branches during wrap-up`);
    console.log(`    ${C.cyan}--auto-approve-plan${C.reset} Skip plan approval gates for this run`);
    console.log(`    ${C.cyan}--no-tui${C.reset}            Disable split-screen display (classic output)`);
    console.log(`    ${C.cyan}--non-interactive${C.reset}   Suppress terminal prompts; leave app gates open instead`);
    console.log(`    ${C.cyan}--dry-run${C.reset}           Research + plan only — dev jobs auto-pass without execution`);
    console.log(`    ${C.cyan}--stall-timeout N${C.reset}   Seconds before killing stalled process`);
    console.log(`    ${C.cyan}--work-item N${C.reset}       Run only jobs for one work item (repeat or comma-separate)`);
    console.log(`    ${C.cyan}--cold-index${C.reset}        Clear the cold index before starting\n`);
  },
  go: () => {
    console.log(`\n  Usage: posse go [flags]`);
    console.log(`  plan + run in one shot: plans queued work items, then starts the scheduler.`);
    console.log(`  ${C.dim}Accepts the same flags as 'run' — see: posse run --help${C.reset}\n`);
  },
  job: () => {
    console.log("Usage: posse job pass|fail <job-id> [--note \"reason\"]");
  },
  gate: () => {
    console.log(`\n  Usage: posse gate answer <gate-job-id> <action> [--feedback "details"]`);
    console.log(`         posse gate answer <gate-job-id> --text "answer"   (a gate without choices)`);
    console.log(`         posse gate show <gate-job-id>   (alias: gate diff)`);
    console.log(`  Resolve a parked human gate without starting the scheduler, or show its question,`);
    console.log(`  choices and, for a verdict on code, the diff it judges.`);
    console.log(`  ${C.dim}Common actions: pass, fail, retry, replan, skip. The gate's catalogued choices remain authoritative.${C.reset}\n`);
  },
  serve: () => {
    console.log(`\n  Usage: posse serve [--show-token] [--pair]`);
    console.log(`  Start this clone's HTTP+WebSocket control bridge for phone/web clients.`);
    console.log(`  ${C.dim}This does not join clones or share Git work; use \`posse pair\` for multi-user shared-trunk collaboration.${C.reset}\n`);
  },
  pair: () => {
    console.log(`\n  Usage:`);
    console.log(`    posse pair [host] [--remote origin] [--branch posse/pair-name]`);
    console.log(`    posse pair <CODE>`);
    console.log(`    posse pair join <CODE>`);
    console.log(`    posse pair status`);
    console.log(`    posse pair leave`);
    console.log(`\n  Opens or joins multi-user collaboration across separate clones on one shared Git side trunk.`);
    console.log(`  Live participants see bounded, read-only peer WI/job summaries outside their local queue.`);
    console.log(`  Each clone keeps its own queue and database; peer activity is never scheduled locally.`);
    console.log(`  The host console takes typed commands: ${C.cyan}close${C.reset} drains and integrates; ${C.cyan}Ctrl+C${C.reset} forces close and integration.`);
    console.log(`  ${C.dim}This does not expose a phone/web control bridge; use \`posse serve --pair\` for that.${C.reset}\n`);
  },
  session: () => {
    console.log(`\n  Usage:`);
    console.log(`    posse session host [--remote origin] [--branch posse/pair-name] [--merge-mode ask|auto] [--deploy-mode ask|auto]`);
    console.log(`    posse session join <CODE|posse://session?...> [--here]`);
    console.log(`    posse session admit <COUNTERSIGN>`);
    console.log(`    posse session members|pending`);
    console.log(`    posse session kick <MEMBER-ID>`);
    console.log(`    posse session invite open|close`);
    console.log(`    posse session scope <MEMBER-ID> '<JSON>'`);
    console.log(`    posse session policy each-member|capability-routing|host-only`);
    console.log(`    posse session publication direct|github-pr`);
    console.log(`    posse session status`);
    console.log(`    posse session hold [reason]`);
    console.log(`    posse session resume`);
    console.log(`    posse session merge|deploy`);
    console.log(`    posse session auto [merge|deploy on|off]`);
    console.log(`    posse session leave|close [--keep-branch|--history-preserving]`);
    console.log(`    posse session integrate [--approve-source-oid SHA --approve-origin-oid SHA]`);
    console.log(`    posse session abandon-integration`);
    console.log(`\n  Opens or joins a shared Posse collaboration session.`);
    console.log(`  Joiners wait for the host to confirm their four-character countersign.`);
    console.log(`  A join typed outside an empty folder runs in ~/posse-sessions/<CODE>; --here joins in this clone instead.`);
    console.log(`  hold keeps this checkout where it is (fetches continue) until resume or 30 minutes pass.`);
    console.log(`  merge squashes the team's work into your branch and deploy pushes it to origin; the session keeps running.`);
    console.log(`  Each asks for your approval unless you turn it on with auto (trusted teams).\n`);
  },
  unpair: () => {
    console.log(`\n  Usage: posse unpair [--json]`);
    console.log(`  Members leave and restore locally; hosts gracefully drain peers and integrate the side trunk.\n`);
  },
  "local-models": () => {
    console.log(`\n  Usage: posse local-models [list [--json] | download [shorthand]]`);
    console.log(`  Lists signed local models with download size and recommended memory.`);
    console.log(`  Downloads always require an interactive, size-aware confirmation.\n`);
  },
  "native-binaries": () => {
    console.log(`\n  Usage: posse native-binaries\n  Reconcile native artifacts and emit NDJSON progress.\n`);
  },
};

export function printCommandUsage(command) {
  COMMAND_USAGE[command]?.();
}

export async function printCommandHelp(command, { projectDir, cmdDoctor, cmdUpdate }) {
  // Doctor and update own richer, lazily loaded help. Dispatching them here
  // keeps `posse <command> --help` out of bootstrap while avoiding a second
  // copy of their timeout and safety contract in the global usage table.
  if (command === "doctor") return cmdDoctor();
  if (command === "update") return cmdUpdate();
  const usage = COMMAND_USAGE[command];
  if (usage) {
    usage();
    return;
  }
  await printGlobalHelp(projectDir);
}

export async function printGlobalHelp(projectDir) {
  const aliasDiagnostic = posseAliasDiagnostic();
  console.log(`
${C.bold}  Posse (claude-org v4) — SQLite Job Queue Orchestrator${C.reset}
  ${C.dim}Project: ${projectDir}${C.reset}
  ${C.dim}Providers: configured per role in Posse settings${C.reset}
  ${C.dim}DB:      ${getRuntimeDbPath(projectDir)}${C.reset}
${aliasDiagnostic}

  ${C.bold}Workflow:${C.reset}
    ${C.cyan}add${C.reset}        Queue a work item (what you want built)
    ${C.cyan}plan${C.reset}       Create research + plan jobs for queued items
    ${C.cyan}run${C.reset}        Execute all pending jobs (scheduler + worker)
    ${C.cyan}go${C.reset}         plan + run in one shot

  ${C.bold}Manage:${C.reset}
    ${C.cyan}queue${C.reset}      Show all work items and their status
    ${C.cyan}status${C.reset}     Detailed job-level status
    ${C.dim}             status [--active] [--limit N|all] [--json]${C.reset}
    ${C.cyan}serve${C.reset}      Control this clone from paired phone/web clients
    ${C.dim}             serve [--show-token] [--pair]${C.reset}
    ${C.cyan}health${C.reset}     Failure/stuck-job health summary
    ${C.cyan}dashboard${C.reset}  Visual job board
    ${C.cyan}doctor${C.reset}     Repair dependencies, native binaries, and Jina
    ${C.dim}             doctor [--dry-run] [--json]${C.reset}
    ${C.cyan}update${C.reset}     Update Posse + dependencies, binaries, and Jina
    ${C.dim}             update [--dry-run] [--json] [--branch main]${C.reset}
    ${C.cyan}tools${C.reset}      Script tools for agents: create, test, secrets, grants
    ${C.dim}             tools [list|new|show|test|secret|grant|revoke] (posse tools help)${C.reset}
    ${C.cyan}review${C.reset}     Approve/reject completed work items
    ${C.cyan}job${C.reset}        Give a parked job an operator verdict, including during a live run
    ${C.dim}             job pass|fail <job-id> [--note "…"]${C.reset}
    ${C.cyan}gate answer${C.reset} Resolve a parked human gate by job ID
    ${C.dim}             gate answer <gate-job-id> pass|fail|retry|replan|skip [--feedback "…"]${C.reset}
    ${C.dim}             gate answer <gate-job-id> --text "…"  (a gate without choices)${C.reset}
    ${C.dim}             gate show <gate-job-id>  (question, choices and the diff a verdict judges)${C.reset}
    ${C.cyan}events${C.reset}     Show event log (audit trail)
    ${C.dim}             events [jobId] [--session]${C.reset}
    ${C.cyan}timeline${C.reset}   Full execution chain for a work item
    ${C.dim}             timeline <wi-id> [--json] [--verbose]${C.reset}
    ${C.cyan}sessions${C.reset}   Session-recycling lanes and token savings
    ${C.dim}             sessions [wi-id] [--json] [--savings] [--all]${C.reset}
    ${C.cyan}cost${C.reset}       Per-WI cost attribution + pricing overrides
    ${C.dim}             cost | cost <wi-id> [--by role|provider|tier|model] [--json] [--recycling]${C.reset}
    ${C.dim}             cost pricing [list|set <provider> <model> <in/M> <out/M>]${C.reset}
    ${C.cyan}fanout${C.reset}     Research fanout quality/readiness report
    ${C.dim}             fanout [--json] [--limit N]${C.reset}
    ${C.cyan}plan review/approve/reject${C.reset}  Review/approve plans before dev/fix run
    ${C.dim}             plan review <wi-id>${C.reset}
    ${C.dim}             plan approve <wi-id>${C.reset}
    ${C.dim}             plan reject <wi-id> [--feedback "…"] [--replan]${C.reset}
    ${C.cyan}calls${C.reset}      Agent call performance stats
    ${C.cyan}prompts${C.reset}    Recent agent prompts (last 3 days, JSONL log)
    ${C.dim}             prompts [--job N] [--role R] [--limit N] [--full]${C.reset}
    ${C.cyan}replay${C.reset}     Compressed replay packet for one agent call
    ${C.dim}             replay <agent-call-id> [--json] [--exact-prompt]${C.reset}
    ${C.cyan}usage${C.reset}      Show cached provider usage/quota tracker
    ${C.dim}             usage [--json] [--refresh|--force-refresh]${C.reset}
    ${C.cyan}atlas-smoke${C.reset}  Run Posse's local ATLAS smoke test against a repo
    ${C.dim}             atlas-smoke <repoPath> [query] [provider]${C.reset}
    ${C.cyan}shared-trunk-smoke${C.reset}  Run a disposable two-clone shared-trunk race/claim smoke
    ${C.dim}             shared-trunk-smoke [--json]${C.reset}
    ${C.cyan}shared-trunk${C.reset}  Inspect or abandon publication journal operations
    ${C.dim}             shared-trunk ops [--json] | shared-trunk ops abandon <id> | shared-trunk provenance reset${C.reset}
    ${C.cyan}pairing-preflight${C.reset}  Verify this member's shared-remote access
    ${C.dim}             pairing-preflight [--json]${C.reset}
    ${C.cyan}pair${C.reset}       Collaborate across clones on a shared Git side trunk
    ${C.dim}             pair [host] [--remote origin] [--branch name] | pair <CODE> | pair join <CODE> | pair leave | pair status${C.reset}
    ${C.dim}             Host: g gracefully drains/integrates; Ctrl+C forces close/integration; unlike serve, pair does not connect phone/web clients${C.reset}
    ${C.cyan}session${C.reset}    Host or join the shared session model (preferred; pair is an alias)
    ${C.dim}             session host|join|admit|status|hold|resume|members|pending|kick|scope|policy|publication|invite|leave|close|integrate|abandon-integration${C.reset}
    ${C.cyan}unpair${C.reset}     Leave pairing; host drains and integrates, members restore locally
    ${C.cyan}atlas${C.reset}        Atlas admin commands
    ${C.dim}             atlas mutations are system-owned; use atlas-v2 diagnostics${C.reset}
    ${C.cyan}atlas-v2${C.reset}     Inspect/manage the ATLAS v2 ledger, views, and warmer queue
    ${C.dim}             atlas-v2 ${atlasV2UsageSummary({ compact: true })}${C.reset}
    ${C.cyan}mcp-status${C.reset} Show repo-scoped MCP runtime state
    ${C.cyan}codex-models${C.reset} Validate/list Codex model candidates through Rust dispatch
    ${C.dim}             codex-models [validate|list] [oauth|api|auto]${C.reset}
    ${C.cyan}local-models${C.reset} List/download signed local models with size and system recommendations
    ${C.dim}             local-models [list [--json] | download [shorthand]]${C.reset}
    ${C.cyan}native-binaries${C.reset} Reconcile signed native artifacts (NDJSON progress)
    ${C.cyan}windows-events${C.reset} Probe Windows crash/resource events into the run dir
    ${C.dim}             windows-events [--around ISO] [--minutes N] [--json]${C.reset}
    ${C.cyan}audit${C.reset}      Provider/handoff audit for jobs or work items
    ${C.dim}             audit | audit <jobId> | audit wi<id> | audit worktrees${C.reset}
    ${C.cyan}admin${C.reset}      Stats, session history, and settings management
    ${C.dim}             admin init [--provider-clis-only] | admin describe --json | admin set/clear [--json] | admin snapshot | admin worktrees | admin memory <note|suppress|correct> <id> | admin provider-pause [clear <provider|all>] | admin settings${C.reset}
    ${C.cyan}merge${C.reset}      Merge a completed WI branch
    ${C.dim}             merge <wi_id> [--yes]${C.reset}
    ${C.cyan}prune${C.reset}      Clean up orphaned worktrees
    ${C.dim}             prune [--dry-run]${C.reset}
    ${C.cyan}purge${C.reset}      Delete ALL posse/* branches + worktrees (asks first)
    ${C.cyan}cleanup${C.reset}    Triage leftover snapshots, branches, worktrees, stashes
    ${C.dim}             cleanup [--auto] [--dry-run]  (--auto asks before discarding)${C.reset}
    ${C.cyan}clear${C.reset}      Reset everything

  ${C.bold}Mid-Run:${C.reset}
    ${C.cyan}inject${C.reset}     Quick-add work item (scheduler picks it up)
    ${C.cyan}ask${C.reset}        Ask a question (research-only, no dev tasks)
    ${C.cyan}image${C.reset}      Generate an image directly (skips research/plan)

  ${C.bold}Flags:${C.reset}
      ${C.cyan}--auto-approve${C.reset}   Dev won't pause for tool permission prompts
      ${C.cyan}--scope-mode MODE${C.reset} File-scope approvals: default or auto (this run only)
      ${C.cyan}--auto-merge${C.reset}     Merge completed WI branches during wrap-up
      ${C.cyan}--no-auto-merge${C.reset}  Disable auto-merge for this run
      ${C.cyan}--auto-approve-plan${C.reset} Skip plan approval gates for this run
      ${C.cyan}--deepthink${C.reset}      Raise planner/research budget for deeper analysis
      ${C.cyan}--deepthink-budget N${C.reset}  Set planner/research budget: low, normal, high, xhigh
      ${C.cyan}--oneshot${C.reset}        Propose one-shot routing; deterministic gate still validates scope and safety
      ${C.cyan}--intent KIND${C.reset}    Intake type: task, bugfix, design, context, question, oneshot, report, image ${C.dim}(hotkeys ok)${C.reset}
      ${C.cyan}--input-contexts${C.reset} Select context dirs from resources/inputs (names, indices, or all)
      ${C.cyan}--files LIST${C.reset}     Optional hinted files for research/planning
      ${C.cyan}--constraints LIST${C.reset} Optional intake constraints for research/planning
      ${C.cyan}--session-recycle${C.reset} Enable session recycling for this work item
      ${C.cyan}--no-session-recycle${C.reset} Disable session recycling for this work item
      ${C.cyan}--red-team-plan${C.reset}  Use primary planner -> red-team planner -> synthesis planner
      ${C.cyan}--iterate${C.reset}        Guided iterative workflow intake ${C.dim}([b]ugfix|[d]esign/ux|[r]efactor|[a]udit|[i]terate)${C.reset}
      ${C.cyan}--iterate-red-team${C.reset} Persist red-team planning across iterative follow-up rounds
      ${C.cyan}--concurrency N${C.reset}  Run N workers in parallel       ${C.dim}(default: ${getCatalogRuntimeFallbackInt("scheduler_concurrency", 3)})${C.reset}
    ${C.cyan}--no-tui${C.reset}         Disable split-screen display (classic output)
    ${C.cyan}--non-interactive${C.reset} Suppress terminal prompts; leave app gates open instead
    ${C.cyan}--bossy${C.reset}          Open the Bossy fleet TUI for this machine's posses instead of the CLI
    ${C.cyan}--dry-run${C.reset}        Research + plan only — dev jobs auto-pass without execution
    ${C.cyan}--stall-timeout N${C.reset}  Seconds before killing stalled process ${C.dim}(default: ${getCatalogRuntimeFallbackInt("stall_timeout", 600)})${C.reset}

  ${C.bold}Settings:${C.reset}
    Runtime behavior is configured in Posse admin/account settings.
    Secrets remain in the environment.

  ${C.bold}Provider / Remote Secrets:${C.reset}
    ${C.cyan}POSSE_KEY${C.reset}                  Posse remote API key ${C.dim}(required for remote prompt/tool catalog)${C.reset}
    ${C.cyan}ANTHROPIC_API_KEY${C.reset}          Anthropic API key ${C.dim}(required if using anthropic provider)${C.reset}
    ${C.cyan}OPENAI_API_KEY${C.reset}             OpenAI API key ${C.dim}(required if using openai provider)${C.reset}
    ${C.cyan}CODEX_API_KEY${C.reset}              Optional Codex CLI API key ${C.dim}(or cached ~/.codex/auth.json login)${C.reset}
    ${C.cyan}XAI_API_KEY${C.reset}                xAI API key ${C.dim}(required if using grok provider)${C.reset}
    ${C.cyan}CLAUDE_CODE_OAUTH_TOKEN${C.reset}    Claude OAuth token override

  ${C.bold}Example:${C.reset}
    posse add "Build a REST API for user management"
    posse add "Add JWT authentication to all endpoints"
    posse go --auto-approve
`);
}
