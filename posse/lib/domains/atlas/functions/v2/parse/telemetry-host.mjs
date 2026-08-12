// @ts-check

import { runDaemonThread } from "../../../../../shared/tools/classes/daemon/thread-host.js";
import { UsageStoreWriter } from "../../../classes/v2/UsageStoreWriter.js";

const writer = new UsageStoreWriter();

runDaemonThread((payload) => {
  const op = String(/** @type {any} */ (payload)?.op || "");
  switch (op) {
    case "record":
      return writer.record(/** @type {any} */ (payload)?.entries);
    case "info":
      return writer.info();
    case "close": {
      const info = writer.info();
      writer.close();
      return { ...info, closed: true };
    }
    default:
      throw new Error(`unknown Atlas usage telemetry op: ${op || "(none)"}`);
  }
});
