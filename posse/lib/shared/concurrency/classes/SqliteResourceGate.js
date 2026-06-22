// @ts-check

import { AsyncResourceGate } from "./AsyncGate.js";
import { sqliteGateKey } from "../functions/sqlite-gate.js";

export class SqliteResourceGate extends AsyncResourceGate {
  normalizeKey(dbPath) {
    return sqliteGateKey(dbPath);
  }
}
