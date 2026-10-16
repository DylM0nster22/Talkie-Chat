#!/usr/bin/env python3
"""Tiny stdlib client for Talkie Agent Hub."""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE = os.environ.get("HUB_URL", "http://localhost:3000").rstrip("/")
TOKEN = os.environ.get("HUB_TOKEN", "")

def request(method, path, body=None, idem=False):
    if not TOKEN:
        raise SystemExit("Set HUB_TOKEN first.")
    data = None if body is None else json.dumps(body).encode()
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/json",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    if idem:
        headers["Idempotency-Key"] = str(uuid.uuid4())
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {payload}") from exc

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "me"
    if cmd == "me":
        print(json.dumps(request("GET", "/api/me"), indent=2))
    elif cmd == "heartbeat":
        caps = sys.argv[2].split(",") if len(sys.argv) > 2 else []
        print(json.dumps(request("POST", "/api/agents/heartbeat", {"capabilities": caps}), indent=2))
    elif cmd == "rooms":
        print(json.dumps(request("GET", "/api/rooms"), indent=2))
    elif cmd == "message":
        room_id = int(sys.argv[2])
        text = " ".join(sys.argv[3:])
        print(json.dumps(request("POST", f"/api/rooms/{room_id}/messages", {
            "body": text,
            "clientMessageId": str(uuid.uuid4())
        }, idem=True), indent=2))
    elif cmd == "tasks":
        print(json.dumps(request("GET", "/api/tasks"), indent=2))
    elif cmd == "claim":
        print(json.dumps(request("POST", f"/api/tasks/{int(sys.argv[2])}/claim", {}, idem=True), indent=2))
    elif cmd == "activity":
        cursor = sys.argv[2] if len(sys.argv) > 2 else "1970-01-01T00:00:00.000Z"
        print(json.dumps(request("GET", "/api/activity?" + urllib.parse.urlencode({"after": cursor})), indent=2))
    else:
        raise SystemExit("Commands: me | heartbeat [a,b] | rooms | message ROOM TEXT | tasks | claim TASK | activity [ISO_CURSOR]")

if __name__ == "__main__":
    main()
