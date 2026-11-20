// Late April Fools: a rotating NSFW tagline under the POSSE masthead and a
// theme song looping while a run is live. On by default; POSSE_APRIL_FOOLS=off
// turns both off.
//
// The song is never shipped or downloaded. It plays only when a file the
// operator supplied exists at POSSE_THEME_SONG or ~/.posse/pedro.<ext>, and
// only when a command-line audio player is already installed.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APRIL_FOOLS_TAGLINES = Object.freeze([
  "because doing it yourself is for virgins",
  "multi-agent solutions: welcome to the gangbang",
  "your backend has never been handled like this",
  "too many models? just another Tuesday",
  "more agents inside your repo than you asked for",
  "we go all the way to prod on the first date",
  "it's not premature if the tests pass",
  "the safe word is Ctrl+C",
  "your repo, six agents, no protection",
  "we finish before you do",
  "rebase me harder",
  "one human, many agents, zero shame",
  "pull out? we don't even pull request",
  "we fork on the first date",
  "context window size absolutely matters",
  "getting handsy with your codebase since 2026",
  "nobody's first time, everybody's last resort",
]);

const SONG_EXTENSIONS = Object.freeze(["mp3", "m4a", "ogg", "opus", "flac", "wav"]);

// Windows has no command-line player by default, so its own media stack is
// driven from PowerShell. The file path travels in the environment, never in
// the command text.
const WINDOWS_LOOP = [
  "Add-Type -AssemblyName PresentationCore;",
  "$player = New-Object System.Windows.Media.MediaPlayer;",
  "$player.Open([uri]$env:POSSE_THEME_SONG_FILE); $player.Play();",
  "while ($true) { Start-Sleep -Milliseconds 500;",
  "if ($player.NaturalDuration.HasTimeSpan -and $player.Position -ge $player.NaturalDuration.TimeSpan) {",
  "$player.Position = [TimeSpan]::Zero; $player.Play() } }",
].join(" ");

// Each player loops by itself where it can; the rest are restarted on exit.
const PLAYERS = Object.freeze([
  { command: "mpv", args: (file) => ["--no-video", "--really-quiet", "--loop-file=inf", file], loops: true },
  { command: "ffplay", args: (file) => ["-nodisp", "-loglevel", "quiet", "-loop", "0", file], loops: true },
  { command: "afplay", args: (file) => [file], loops: false },
  { command: "paplay", args: (file) => [file], loops: false },
  { command: "powershell", platform: "win32", loops: true,
    args: () => ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_LOOP] },
]);

// A player that exits this soon could not play (no audio device, a file it
// cannot read); restarting it would only spin.
const PLAYED_AT_LEAST_MS = 2000;

export function aprilFoolsEnabled(env = process.env) {
  const setting = String(env.POSSE_APRIL_FOOLS || "").trim().toLowerCase();
  // Test runs render exact dashboards and must never start a player.
  if (!setting && (env.POSSE_TEST_RUN === "1" || env.NODE_TEST_CONTEXT)) return false;
  return !["off", "0", "false", "no"].includes(setting);
}

let chosenTagline = null;

/** One tagline per process, so the header does not flicker between redraws. */
export function aprilFoolsTagline({ env = process.env, random = Math.random } = {}) {
  if (!aprilFoolsEnabled(env)) return null;
  if (chosenTagline == null) {
    chosenTagline = APRIL_FOOLS_TAGLINES[Math.floor(random() * APRIL_FOOLS_TAGLINES.length) % APRIL_FOOLS_TAGLINES.length];
  }
  return chosenTagline;
}

export function themeSongPath({ env = process.env, homeDir = os.homedir(), exists = fs.existsSync } = {}) {
  const explicit = String(env.POSSE_THEME_SONG || "").trim();
  if (explicit) return exists(explicit) ? explicit : null;
  for (const extension of SONG_EXTENSIONS) {
    const candidate = path.join(homeDir, ".posse", `pedro.${extension}`);
    if (exists(candidate)) return candidate;
  }
  return null;
}

function installedPlayer() {
  const probe = process.platform === "win32" ? "where" : "which";
  return PLAYERS.find((player) => {
    if (player.platform && player.platform !== process.platform) return false;
    try { return spawnSync(probe, [player.command], { stdio: "ignore" }).status === 0; } catch { return false; }
  }) || null;
}

/**
 * Loop the theme song until the returned function is called or the process
 * exits. Returns a no-op when the joke is off, no file was supplied, or no
 * player is installed; it never throws into the run.
 */
export function startThemeSong({ env = process.env, findPlayer = installedPlayer, launch = spawn, now = Date.now } = {}) {
  const noop = () => {};
  if (!aprilFoolsEnabled(env)) return noop;
  const file = themeSongPath({ env });
  if (!file) return noop;
  const player = findPlayer();
  if (!player) return noop;

  let stopped = false;
  let child = null;
  const play = () => {
    if (stopped) return;
    try {
      const started = now();
      child = launch(player.command, player.args(file), { stdio: "ignore", windowsHide: true, env: { ...env, POSSE_THEME_SONG_FILE: file } });
      child.on("error", () => { stopped = true; });
      child.on("exit", () => { if (!player.loops && now() - started >= PLAYED_AT_LEAST_MS) play(); });
    } catch {
      stopped = true;
    }
  };
  const stop = () => {
    stopped = true;
    try { child?.kill(); } catch { /* already gone */ }
    process.removeListener("exit", stop);
  };
  process.on("exit", stop);
  play();
  return stop;
}

export function __resetAprilFoolsForTests() {
  chosenTagline = null;
}
