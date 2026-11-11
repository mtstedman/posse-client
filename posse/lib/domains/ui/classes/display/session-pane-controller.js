// Keys of the run screen's Session pane: row selection and, from the host's
// seat, the actions on the selected row and on the session. Every action ends
// in the `u` session-command path (_submitSessionCommand, or its prompt with
// the command started); nothing here calls the session itself.

import { C } from "../../../../shared/format/functions/colors.js";
import { SESSION_RIGHT_MODE, sessionSummaryRow } from "../../functions/display/session-mode.js";
import {
  moveSessionSelection,
  resolveSessionPrompt,
  resolveSessionSelection,
  sessionActionPlan,
  sessionPaneKeyAction,
  sessionPaneKeyName,
  sessionPaneRows,
} from "../../functions/display/session-pane.js";

export class DisplaySessionPaneController {
  /** The session summary the pane renders from, or null outside a session. */
  _sessionPaneSession() {
    if (typeof this.getPipelineData !== "function") return null;
    try { return sessionSummaryRow(this.getPipelineData()); } catch { return null; }
  }

  /**
   * Handle a key while no input is open. Returns true when the pane used the
   * key; false leaves it to the run screen's global keys.
   */
  _onSessionPaneKeypress(str, key) {
    if (this._rightMode !== SESSION_RIGHT_MODE) {
      this._sessionPrompt = null;
      return false;
    }
    const session = this._sessionPaneSession();
    if (!session) {
      this._sessionPrompt = null;
      return false;
    }
    const role = session.role === "host" ? "host" : "member";
    const rows = sessionPaneRows(session);
    const name = sessionPaneKeyName(str, key);
    const selectedId = resolveSessionSelection(rows, this._sessionSelectedId, { role });
    this._sessionSelectedId = selectedId;
    const row = rows.find((item) => item.id === selectedId) || null;

    // An open prompt takes every key, so its keys may repeat global ones.
    if (this._sessionPrompt) {
      const outcome = resolveSessionPrompt(this._sessionPrompt, name, { role, rows, session });
      if (outcome?.gone) {
        this._sessionPrompt = null;
        this.addEvent(`${C.yellow}That member is no longer in the session; nothing was changed.${C.reset}`);
      } else if (outcome?.cancel) {
        this._sessionPrompt = null;
      } else if (outcome?.plan) {
        this._applySessionPanePlan(outcome.plan);
      }
      return true;
    }

    if (name === "up" || name === "down") {
      const delta = name === "up" ? -1 : 1;
      const next = moveSessionSelection(rows, selectedId, delta);
      if (next.moved) {
        this._sessionSelectedId = next.selectedId;
        this._sessionFollowSelection = true;
      } else {
        // Past either end of the roster the keys scroll the pane's content.
        this._sessionScroll = Math.max(0, (this._sessionScroll || 0) + delta);
      }
      return true;
    }

    // Host actions need the session-command path; a member's seat has none.
    if (!this.onSessionCommand) return false;
    const action = sessionPaneKeyAction({ role, row, key: name });
    if (!action) return false;
    this._applySessionPanePlan(sessionActionPlan(action, { role, row, session }));
    return true;
  }

  _applySessionPanePlan(plan) {
    if (!plan) {
      this._sessionPrompt = null;
      return;
    }
    if (plan.kind === "prompt") {
      this._sessionPrompt = plan.prompt;
      return;
    }
    this._sessionPrompt = null;
    if (plan.kind === "prefill") {
      this._startSessionCommand();
      this._inputBuf = plan.text;
    } else if (plan.kind === "command") {
      // Exactly what Enter does in the `u` prompt.
      this._inputBuf = plan.command;
      this._submitSessionCommand();
    }
  }
}
