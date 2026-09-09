#!/usr/bin/env node
import { AutomationOwner } from "../classes/AutomationOwner.js";

const owner = new AutomationOwner();
let closing = false;
async function close() {
  if (closing) return; closing = true;
  try { await owner.close(); } finally { process.exit(0); }
}
process.on("SIGINT", close); process.on("SIGTERM", close);
try { await owner.start(); } catch (error) { process.stderr.write(`posse automation owner: ${error?.stack || error}\n`); process.exit(1); }
