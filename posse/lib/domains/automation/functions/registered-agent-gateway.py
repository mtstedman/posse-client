#!/usr/bin/env python3
"""Linux peer-credential boundary for locally registered agents.

One client frame is forwarded over the owner's private socket. The HMAC binds
the kernel identity and the exact frame; applications never reach that socket.
Progress lines the owner writes before its final frame are relayed unchanged.
"""

import base64
import hashlib
import hmac
import json
import os
import pwd
import secrets
import socket
import stat
import struct
import threading
import time

PUBLIC = os.environ.get("POSSE_AGENT_GATEWAY_SOCKET", "/run/posse-agent/public.sock")
BACKEND = os.environ.get("POSSE_AGENT_GATEWAY_BACKEND", "/run/posse-agent/private/registered.sock")
KEY_FILE = os.environ.get("POSSE_AGENT_GATEWAY_KEY", "/var/lib/posse-agent/gateway.key")
MAX_FRAME = 1024 * 1024
SLOTS = threading.BoundedSemaphore(64)


def read_frame(conn, limit=MAX_FRAME):
    data = bytearray()
    while len(data) <= limit:
        chunk = conn.recv(min(65536, limit + 1 - len(data)))
        if not chunk:
            raise ValueError("closed frame")
        data.extend(chunk)
        end = data.find(b"\n")
        if end >= 0:
            if end > limit or data[end + 1:].strip():
                raise ValueError("invalid frame")
            return bytes(data[:end])
    raise ValueError("oversized frame")


class LineReader:
    """Reads newline-delimited frames from one socket, keeping bytes between frames."""

    def __init__(self, conn, limit):
        self.conn, self.limit, self.data = conn, limit, bytearray()

    def next(self):
        while True:
            end = self.data.find(b"\n")
            if end >= 0:
                if end > self.limit:
                    raise ValueError("oversized frame")
                line = bytes(self.data[:end])
                del self.data[:end + 1]
                return line
            if len(self.data) > self.limit:
                raise ValueError("oversized frame")
            chunk = self.conn.recv(65536)
            if not chunk:
                raise ValueError("closed frame")
            self.data.extend(chunk)


def is_progress(line):
    try:
        value = json.loads(line)
    except (ValueError, UnicodeError):
        return False
    return isinstance(value, dict) and "progress" in value and "ok" not in value


def handle(conn, key):
    relaying = False
    try:
        conn.settimeout(5)
        pid, uid, gid = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        account = pwd.getpwuid(uid)
        # NSS is authoritative for current membership, not caller-provided JSON.
        groups = sorted(set(os.getgrouplist(account.pw_name, gid)))
        frame = read_frame(conn)
        request = json.loads(frame)
        if not isinstance(request, dict):
            raise ValueError("invalid request")
        encoded = base64.b64encode(frame).decode("ascii")
        nonce = secrets.token_hex(16)
        stamp = int(time.time())
        signed = f"{nonce}\n{stamp}\n{uid}\n{gid}\n{account.pw_name}\n{','.join(map(str, groups))}\n{encoded}".encode()
        envelope = {"kind": "local_gateway", "nonce": nonce, "timestamp": stamp,
                    "uid": uid, "gid": gid, "groups": groups, "user": account.pw_name,
                    "frame": encoded, "mac": hmac.new(key, signed, hashlib.sha256).hexdigest()}
        with socket.socket(socket.AF_UNIX) as backend:
            backend.settimeout(900)
            backend.connect(BACKEND)
            backend.sendall(json.dumps(envelope, separators=(",", ":")).encode() + b"\n")
            reader = LineReader(backend, MAX_FRAME + 1024)
            while True:
                response = reader.next()
                progress = request.get("progress") is True and is_progress(response)
                conn.sendall(response + b"\n")
                if not progress:
                    break
                if not relaying:
                    relaying = True
                    conn.settimeout(30)
    except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
        try:
            # Once progress has been relayed the request was accepted; report the lost owner, not a rejection.
            conn.sendall(b'{"ok":false,"code":"owner_unavailable","error":"Registered owner closed without a response"}\n'
                         if relaying else b'{"ok":false,"code":"unauthorized","error":"Registered gateway rejected request"}\n')
        except OSError:
            pass
    finally:
        conn.close()
        SLOTS.release()


def main():
    key_stat = os.lstat(KEY_FILE)
    if not stat.S_ISREG(key_stat.st_mode) or key_stat.st_mode & 0o077 or key_stat.st_uid != os.geteuid():
        raise RuntimeError("gateway key is not private")
    with open(KEY_FILE, "rb") as source:
        key = source.read().strip()
    if len(key) < 32:
        raise RuntimeError("gateway key is invalid")
    if os.path.lexists(PUBLIC):
        old = os.lstat(PUBLIC)
        if not stat.S_ISSOCK(old.st_mode) or old.st_uid != os.geteuid():
            raise RuntimeError("public socket path is occupied")
        os.unlink(PUBLIC)
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(PUBLIC)
        os.chmod(PUBLIC, 0o666)
        server.listen(64)
        while True:
            conn, _ = server.accept()
            if not SLOTS.acquire(False):
                conn.close()
                continue
            threading.Thread(target=handle, args=(conn, key), daemon=True).start()


if __name__ == "__main__":
    main()
