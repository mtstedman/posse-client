import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const KEY_FILE = "wi-grant-ed25519.pem";

function keyDirectory(projectDir, state) {
  const directory = path.resolve(String(state?.credential_directory || ""));
  const root = path.resolve(projectDir, ".posse", "session-credentials");
  if (path.dirname(directory) !== root || !state?.remote_session_id) {
    throw new Error("Host session credential directory is unavailable");
  }
  return directory;
}

/** Keep this signer separate from the Git SSH deploy key. The private half
 * never leaves the host's session credential directory. */
export function loadOrCreateTeamSigningKey(projectDir, state) {
  const directory = keyDirectory(projectDir, state);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dirStat = fs.lstatSync(directory);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o077) !== 0) {
    throw new Error("Host session credential directory permissions are unsafe");
  }
  const filename = path.join(directory, KEY_FILE);
  let privatePem;
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Host grant key permissions are unsafe");
    privatePem = fs.readFileSync(filename);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const pair = generateKeyPairSync("ed25519");
    privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" });
    const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
      | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeFileSync(fd, privatePem); } finally { fs.closeSync(fd); }
  }
  const privateKey = createPrivateKey(privatePem);
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicBytes = spki.subarray(-32);
  const signingPublicKey = publicBytes.toString("base64url");
  const kid = createHash("sha256").update(publicBytes).digest("hex");
  return { privateKey, signingPublicKey, kid };
}

export function signTeamGrantClaims(privateKey, kid, claims) {
  const header = { alg: "EdDSA", typ: "posse-wi-grant+jwt", kid };
  const input = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

export function newTeamGrantJti() {
  return randomUUID();
}
