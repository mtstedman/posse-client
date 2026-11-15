// The host's approval of work leaving the session: what it carries, then a
// typed "yes". Shared by close (and `posse session integrate`) and in-session
// merge and deploy.

import { createInterface } from "node:readline/promises";

// What the host is asked to approve: where it goes, the session's commits and
// who wrote them, and the files it changes.
export function printPromotionForApproval(C, summary, print = console.log) {
  if (!summary) return;
  const kind = summary.strategy === "fast-forward" ? "history-preserving" : "squash";
  print(`\n  ${C.bold}${summary.heading || `Ready to publish to ${summary.target}`}${C.reset} (${kind})`);
  // Merges approved earlier in the session but never deployed leave with this
  // publication; the host approved them for their branch, not for origin.
  if (summary.ridingMerges > 0) {
    print(`  Includes ${summary.ridingMerges} earlier session merge${summary.ridingMerges === 1 ? "" : "s"} not yet on ${summary.target}.`);
  }
  if (summary.commitCount > 0) {
    const authors = summary.authors.map((author) => `${author.name} (${author.count})`).join(", ");
    print(`  ${summary.commitCount} session commit${summary.commitCount === 1 ? "" : "s"} by ${authors}:`);
    for (const commit of summary.commits) print(`    ${commit.sha} ${commit.author}: ${commit.subject}`);
    if (summary.commitCount > summary.commits.length) {
      print(`    ... and ${summary.commitCount - summary.commits.length} more`);
    }
  }
  if (summary.files.length > 0) {
    print("  Changes:");
    for (const line of summary.files) print(`    ${line}`);
    if (summary.moreFiles > 0) print(`    ... and ${summary.moreFiles} more file(s)`);
  }
  if (summary.changeSummary) print(`  ${summary.changeSummary}`);
}

// Asks on the terminal only. Returns true or false for the host's answer, and
// null when there is no one to ask (a closed terminal, piped input): the
// candidate then stays frozen and only exact OIDs can approve it.
export async function askToPublishPromotion(C, summary, {
  input = process.stdin,
  output = process.stdout,
  question = null,
} = {}) {
  if (!summary || !input?.isTTY || !output?.isTTY || input.readableEnded) return null;
  if (input.isRaw) input.setRawMode(false);
  const prompt = createInterface({ input, output });
  // Input that ends at the prompt (Ctrl+D, a closed stream) closes readline
  // without settling the question, so the close itself answers it.
  const closed = new Promise((resolve) => prompt.once("close", () => resolve(null)));
  // Publishing takes the whole word: a stray "y" and Enter typed while the
  // close drained sit in the terminal's buffer and would otherwise answer a
  // question the host has not read yet.
  const asked = prompt.question(question
    || `\n  Type ${C.bold}yes${C.reset} to publish to ${C.cyan}${summary.target}${C.reset} (anything else keeps it frozen): `);
  asked.catch(() => {});
  try {
    const answer = await Promise.race([asked, closed]);
    return answer !== null && String(answer).trim().toLowerCase() === "yes";
  } catch (error) {
    // Ctrl+C or Ctrl+D at the prompt is a no: the candidate stays frozen.
    if (error?.name === "AbortError") return false;
    throw error;
  } finally {
    prompt.close();
  }
}

// What to do with the session's tree on quit. Returns "keep" or "purge" for an
// explicit answer, and null for Enter (today's behavior) or when there is no
// one to ask, so a closed terminal never changes what close does.
export async function askTreeAction(C, { branch, repository = null }, {
  input = process.stdin,
  output = process.stdout,
} = {}) {
  if (!input?.isTTY || !output?.isTTY || input.readableEnded) return null;
  if (input.isRaw) input.setRawMode(false);
  const prompt = createInterface({ input, output });
  const closed = new Promise((resolve) => prompt.once("close", () => resolve(null)));
  output.write(`\n  ${C.bold}What should happen to this session's tree${C.reset} (${branch}${repository ? ` and its private repo ${repository}` : ""})?\n`
    + `    ${C.cyan}k${C.reset}  leave it up: keep the branch, the private repo and its key so you can rejoin it later\n`
    + `    ${C.cyan}p${C.reset}  purge it: delete the branch, the repo and the recovery refs once its work is published\n`
    + `    ${C.dim}Enter  as before: delete the repo, keep the local branch${C.reset}\n`);
  const asked = prompt.question("  [k/p/Enter]: ");
  asked.catch(() => {});
  try {
    const answer = await Promise.race([asked, closed]);
    const choice = answer === null ? "" : String(answer).trim().toLowerCase();
    if (["k", "keep", "leave", "up"].includes(choice)) return "keep";
    if (["p", "purge", "delete"].includes(choice)) return "purge";
    return null;
  } catch (error) {
    if (error?.name === "AbortError") return null;
    throw error;
  } finally {
    prompt.close();
  }
}

// Offered when hosting and trees were left up: rejoin one, or make a new one.
// Returns the chosen tree, or null for a new tree (Enter, or no one to ask).
export async function askRejoinTree(C, entries, {
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const usable = entries.filter((entry) => !entry.problem);
  if (usable.length === 0 || !input?.isTTY || !output?.isTTY || input.readableEnded) return null;
  if (input.isRaw) input.setRawMode(false);
  const prompt = createInterface({ input, output });
  const closed = new Promise((resolve) => prompt.once("close", () => resolve(null)));
  let number = 0;
  const lines = entries.map((entry) => {
    if (entry.problem) return `    ${C.dim}-  ${entry.tree.branch}  cannot be rejoined: ${entry.problem}${C.reset}`;
    number += 1;
    const kept = entry.tree.keptAt ? `kept ${String(entry.tree.keptAt).slice(0, 10)}` : "kept";
    return `    ${C.cyan}${number}${C.reset}  ${entry.tree.branch}  ${C.dim}${kept} · ${entry.tree.repository}${C.reset}`;
  });
  output.write(`\n  ${C.bold}You have session trees left up.${C.reset} Rejoin one (no new upload) or make a new one?\n${lines.join("\n")}\n`
    + `    ${C.dim}Enter  make a new tree${C.reset}\n`);
  const asked = prompt.question(`  [1${usable.length > 1 ? `-${usable.length}` : ""}/Enter]: `);
  asked.catch(() => {});
  try {
    const answer = await Promise.race([asked, closed]);
    const choice = Number.parseInt(String(answer ?? "").trim(), 10);
    return Number.isInteger(choice) && choice >= 1 && choice <= usable.length ? usable[choice - 1].tree : null;
  } catch (error) {
    if (error?.name === "AbortError") return null;
    throw error;
  } finally {
    prompt.close();
  }
}
