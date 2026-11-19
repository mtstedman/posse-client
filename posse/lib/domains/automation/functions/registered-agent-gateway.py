#!/usr/bin/env python3
"""Linux peer-credential boundary for locally registered agents.

One client frame is forwarded over the owner's private socket. The HMAC binds
the kernel identity and the exact frame; applications never reach that socket.
Progress lines the owner writes before its final frame are relayed unchanged.
A caller that hangs up while the owner works frees its slot; the owner keeps
the turn, and the caller recovers it by repeating its idempotency key.
"""

import base64
import hashlib
import hmac
import json
import os
import pwd
import secrets
import select
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
# The caller has this long to send its whole request frame.
READ_TIMEOUT = 5
# lib/catalog/agent.js AGENT_LIMITS.wall_seconds: an accepted turn may run this
# long, so the gateway waits at least as long for the owner to answer.
AGENT_WALL_LIMIT_SECONDS = 3600
BACKEND_TIMEOUT = AGENT_WALL_LIMIT_SECONDS + 60
REJECTED = b'{"ok":false,"code":"unauthorized","error":"Registered gateway rejected request"}\n'
OWNER_LOST = b'{"ok":false,"code":"owner_unavailable","error":"Registered owner closed without a response"}\n'
OWNER_TIMEOUT = (b'{"ok":false,"code":"owner_timeout","error":"Registered owner did not answer in time;'
                 b' repeat the idempotency key to collect the outcome"}\n')


class OwnerTimeout(Exception):
    """The owner accepted the request but did not answer within BACKEND_TIMEOUT."""


class CallerGone(Exception):
    """The caller closed its connection while the owner was still working."""


def read_frame(conn, deadline, limit=MAX_FRAME):
    data = bytearray()
    while len(data) <= limit:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise socket.timeout("request frame timed out")
        conn.settimeout(remaining)
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

    def __init__(self, conn, limit, wait=None):
        self.conn, self.limit, self.data, self.wait = conn, limit, bytearray(), wait

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
            if self.wait:
                self.wait()
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


def owner_waiter(backend, conn):
    """Block until the owner has bytes, the caller hangs up, or BACKEND_TIMEOUT passes."""
    poller = select.poll()
    poller.register(backend, select.POLLIN)
    # POLLHUP is reported only once the caller has closed both directions, so a
    # caller that half-closes after sending its frame still gets its answer.
    poller.register(conn, 0)

    def wait():
        deadline = time.monotonic() + BACKEND_TIMEOUT
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise OwnerTimeout()
            events = dict(poller.poll(remaining * 1000))
            if events.get(conn.fileno(), 0) & (select.POLLHUP | select.POLLERR | select.POLLNVAL):
                raise CallerGone()
            if backend.fileno() in events:
                return
    return wait


def reply(conn, line):
    try:
        conn.sendall(line)
    except OSError:
        pass


def handle(conn, key):
    relaying = False
    try:
        pid, uid, gid = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        account = pwd.getpwuid(uid)
        # NSS is authoritative for current membership, not caller-provided JSON.
        groups = sorted(set(os.getgrouplist(account.pw_name, gid)))
        frame = read_frame(conn, time.monotonic() + READ_TIMEOUT)
        conn.settimeout(READ_TIMEOUT)
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
            backend.settimeout(BACKEND_TIMEOUT)
            backend.connect(BACKEND)
            backend.sendall(json.dumps(envelope, separators=(",", ":")).encode() + b"\n")
            reader = LineReader(backend, MAX_FRAME + 1024, owner_waiter(backend, conn))
            while True:
                response = reader.next()
                progress = request.get("progress") is True and is_progress(response)
                conn.sendall(response + b"\n")
                if not progress:
                    break
                if not relaying:
                    relaying = True
                    conn.settimeout(30)
    except OwnerTimeout:
        # The owner still holds the turn; this is not a rejection.
        reply(conn, OWNER_TIMEOUT)
    except CallerGone:
        pass
    except (KeyError, OSError, ValueError, UnicodeError, json.JSONDecodeError):
        # KeyError: the caller's uid has no account entry.
        # Once progress has been relayed the request was accepted; report the lost owner, not a rejection.
        reply(conn, OWNER_LOST if relaying else REJECTED)
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
