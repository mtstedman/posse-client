import { BUDGET_USAGE } from "../../../catalog/admission-budget.js";
import { readAdmissionBudget, configureAdmissionBudget, changeBudgetState, reconcileBudgetCost } from "../../queue/functions/admission-budget.js";

export function runBudgetCommand(argv = []) {
  const [action = "show", rawId, ...args] = argv;
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(BUDGET_USAGE);
  if (action === "show") return readAdmissionBudget(id);
  if (action === "configure") {
    const number = value => value == null || value === "-" ? null : Number(value);
    return configureAdmissionBudget(id, { limitUsd: number(args[0]), reservationUsd: number(args[1]), minutes: number(args[2]) });
  }
  if (action === "reconcile") return reconcileBudgetCost(id, args[0], Number(args[1]), args.slice(2).join(" "));
  if (["pause", "resume", "disable"].includes(action)) return changeBudgetState(id, action);
  throw new Error(BUDGET_USAGE);
}
