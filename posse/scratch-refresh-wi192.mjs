// Throwaway: recompute WI#192 status from its (now-terminal) jobs via the proper
// Posse function, so the live scheduler merges it and releases the streams.tsx
// lock blocking WI#193. Run with cwd=streaming so getDb targets that project.
import { refreshWorkItemStatus, getWorkItem } from "./lib/domains/queue/functions/index.js";
import { getRuntimeDbPath } from "./lib/domains/runtime/functions/paths.js";

console.log("DB:", getRuntimeDbPath());
console.log("WI#192 before:", JSON.stringify(getWorkItem(192)?.status));
const result = refreshWorkItemStatus(192);
console.log("refreshWorkItemStatus(192) ->", JSON.stringify(result));
console.log("WI#192 after:", JSON.stringify(getWorkItem(192)?.status));
