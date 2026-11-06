import fs from "node:fs";

// An open descriptor remains writable after unlink, but its bytes are lost.
export function logDescriptorMatchesPath(fd, filePath) {
  try {
    const opened = fs.fstatSync(fd);
    const current = fs.statSync(filePath);
    return opened.dev === current.dev && opened.ino === current.ino;
  } catch { return false; }
}
