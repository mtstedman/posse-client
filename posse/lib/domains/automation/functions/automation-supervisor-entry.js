#!/usr/bin/env node
import { AutomationSupervisor } from "../classes/AutomationSupervisor.js";
import { AUTOMATION_OWNER_LAUNCH, AUTOMATION_SUPERVISOR_AD_HOC_ARG } from "../../../catalog/custom-tools.js";

const supervisor = new AutomationSupervisor({
  launch: process.argv.slice(2).includes(AUTOMATION_SUPERVISOR_AD_HOC_ARG)
    ? AUTOMATION_OWNER_LAUNCH.AD_HOC
    : AUTOMATION_OWNER_LAUNCH.SERVICE,
});
process.once("SIGINT", () => supervisor.stop("SIGINT"));
process.once("SIGTERM", () => supervisor.stop("SIGTERM"));

// Giving up after repeated start-up failures is a failure a service manager
// may restart; every other outcome is a deliberate stop.
if (await supervisor.run() === "gave_up") process.exitCode = 1;
