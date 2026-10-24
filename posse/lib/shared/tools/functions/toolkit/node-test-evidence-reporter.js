// The per-file summary is emitted by node:test only when registered tests ran.
// Its synthetic passing file wrapper (including process.exit(0)) has no such
// summary. Keep evidence separate from application stdout and preserve the standard spec diagnostics.
import { NODE_TEST_EVIDENCE_FILE_ENV } from "../../../../catalog/process.js";
import fs from "node:fs";
import { spec } from "node:test/reporters";
import { Readable } from "node:stream";

export default async function* reporter(source) {
  async function* observe() {
    for await (const event of source) {
      if (event.type === "test:summary") {
        fs.appendFileSync(process.env[NODE_TEST_EVIDENCE_FILE_ENV], `${JSON.stringify({ file: event.data.file, counts: event.data.counts })}\n`);
      }
      yield event;
    }
  }
  yield* Readable.from(observe()).pipe(new spec());
}
