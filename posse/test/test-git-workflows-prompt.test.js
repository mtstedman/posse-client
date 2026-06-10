import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { askSingleKeyYesNo } from "../lib/domains/cli/functions/git-workflows.js";

class FakeStdin extends EventEmitter {
  constructor({ isTTY = true, isRaw = false } = {}) {
    super();
    this.isTTY = isTTY;
    this.isRaw = isRaw;
    this.paused = true;
    this.rawModes = [];
    this.resumeCount = 0;
    this.pauseCount = 0;
  }

  setRawMode(value) {
    this.isRaw = value;
    this.rawModes.push(value);
  }

  resume() {
    this.paused = false;
    this.resumeCount++;
  }

  pause() {
    this.paused = true;
    this.pauseCount++;
  }

  isPaused() {
    return this.paused;
  }
}

class FakeStdout {
  constructor() {
    this.chunks = [];
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }
}

describe("git workflow prompts", () => {
  it("accepts a TTY push confirmation with one keypress", async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();

    const answerPromise = askSingleKeyYesNo("  Push to remote? [y/N] ", { stdin, stdout });
    stdin.emit("data", Buffer.from("y"));
    const answer = await answerPromise;

    assert.equal(answer, "y");
    assert.deepEqual(stdin.rawModes, [true, false]);
    assert.equal(stdin.resumeCount, 1);
    assert.equal(stdin.pauseCount, 1);
    assert.equal(stdout.chunks.join(""), "  Push to remote? [y/N] y\n");
  });

  it("preserves already-resumed TTY stdin after single-key prompt", async () => {
    const stdin = new FakeStdin();
    stdin.resume();
    const stdout = new FakeStdout();

    const answerPromise = askSingleKeyYesNo("  Push to remote? [y/N] ", { stdin, stdout });
    stdin.emit("data", Buffer.from("n"));
    const answer = await answerPromise;

    assert.equal(answer, "");
    assert.equal(stdin.pauseCount, 0);
    assert.equal(stdin.paused, false);
  });

  it("uses the readline-style fallback for non-TTY input", async () => {
    const stdin = new FakeStdin({ isTTY: false });
    const stdout = new FakeStdout();
    let seenPrompt = "";

    const answer = await askSingleKeyYesNo("  Push to remote? [y/N] ", {
      stdin,
      stdout,
      fallbackAsk: async (prompt) => {
        seenPrompt = prompt;
        return "yes";
      },
    });

    assert.equal(answer, "yes");
    assert.equal(seenPrompt, "  Push to remote? [y/N] ");
    assert.equal(stdout.chunks.join(""), "");
  });
});
