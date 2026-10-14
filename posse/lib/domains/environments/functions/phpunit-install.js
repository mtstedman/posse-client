import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { managedPhpUnitPath } from "./phpunit-runtime.js";
import { runCommand } from "./scip-install-runtime.js";

function verified(file, release) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") === release.sha256; }
  catch { return false; }
}

export function managedPhpUnitInstalled(installRoot, release) {
  return !!release && verified(managedPhpUnitPath(installRoot), release);
}

export async function installManagedPhpUnit({ installRoot, release, dryRun = false, fetchImpl = globalThis.fetch, run = runCommand }) {
  if (!release) return { ok: false, message: "PHPUnit needs PHP 8.1+" };
  const file = managedPhpUnitPath(installRoot);
  const present = managedPhpUnitInstalled(installRoot, release);
  if (dryRun) return { ok: true, status: "dry-run", message: `would ensure PHPUnit ${release.version} in ${file}` };
  let temporary;
  try {
    if (!present) {
      const response = await fetchImpl(`https://phar.phpunit.de/phpunit-${release.version}.phar`, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} downloading PHPUnit`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== release.sha256) throw new Error("PHPUnit download checksum mismatch");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      temporary = `${file}.${crypto.randomUUID()}.tmp.phar`;
      fs.writeFileSync(temporary, bytes, { flag: "wx" });
    }
    const probe = await run("php", [temporary || file, "--version"], { timeoutMs: 30_000 });
    if (!probe.ok || !probe.message.includes(`PHPUnit ${release.version} `)) {
      throw new Error(`PHPUnit could not start; check PHP's dom, mbstring, xml and xmlwriter extensions: ${probe.message}`);
    }
    if (temporary) fs.renameSync(temporary, file);
    return { ok: true, status: present ? "ok" : "installed", message: `PHPUnit ${release.version} installed` };
  } catch (error) {
    return { ok: false, message: String(error?.message || error) };
  } finally {
    if (temporary) fs.rmSync(temporary, { force: true });
  }
}
