import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  editorCommandLabel,
  parseEditorCommand,
  resolveEditorCommand,
} from "../lib/domains/cli/functions/editor.js";

function existsOnly(...paths) {
  const normalized = new Set(paths.map((item) => path.win32.normalize(item).toLowerCase()));
  return (candidate) => normalized.has(path.win32.normalize(candidate).toLowerCase());
}

function fakeWhere(lines) {
  return (cmd, args) => {
    assert.equal(cmd, "where.exe");
    assert.ok(["code", "code.cmd", "Code.exe"].includes(args[0]));
    return lines[args[0]] || "";
  };
}

describe("editor command resolution", () => {
  it("prefers a verified Windows Code.exe over a broken current-directory code shim", () => {
    const badShim = "C:\\development\\claude\\mermaids-grotto\\code.cmd";
    const goodShim = "C:\\Users\\mason\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd";
    const goodExe = "C:\\Users\\mason\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe";

    const resolved = resolveEditorCommand({
      platform: "win32",
      env: {},
      execFileSyncFn: fakeWhere({ code: `${badShim}\r\n${goodShim}\r\n` }),
      existsSyncFn: existsOnly(goodExe),
    });

    assert.equal(resolved, `"${goodExe}" --wait`);
  });

  it("falls back to notepad on Windows when VS Code is not installed", () => {
    const resolved = resolveEditorCommand({
      platform: "win32",
      env: {},
      execFileSyncFn: fakeWhere({ code: "C:\\repo\\code.cmd\r\n" }),
      existsSyncFn: () => false,
    });

    assert.equal(resolved, "notepad");
  });

  it("normalizes explicit EDITOR=code on Windows without changing custom editors", () => {
    const goodExe = "C:\\Users\\mason\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe";
    const execFileSyncFn = fakeWhere({
      code: "C:\\Users\\mason\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd\r\n",
    });

    assert.equal(resolveEditorCommand({
      platform: "win32",
      env: { EDITOR: "code --wait" },
      execFileSyncFn,
      existsSyncFn: existsOnly(goodExe),
    }), `"${goodExe}" --wait`);

    assert.equal(resolveEditorCommand({
      platform: "win32",
      env: { EDITOR: "code" },
      execFileSyncFn,
      existsSyncFn: existsOnly(goodExe),
    }), `"${goodExe}" --wait`);

    assert.equal(resolveEditorCommand({
      platform: "win32",
      env: { EDITOR: "vim -n" },
      execFileSyncFn,
      existsSyncFn: existsOnly(goodExe),
    }), "vim -n");
  });

  it("parses and labels quoted editor commands with spaces", () => {
    const command = '"C:\\Program Files\\Microsoft VS Code\\Code.exe" --wait --reuse-window';
    assert.deepEqual(parseEditorCommand(command), {
      cmd: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
      args: ["--wait", "--reuse-window"],
    });
    assert.equal(editorCommandLabel(command), "Code");
  });
});
