"""Verify all 4 tools emit only content[0].text (no structuredContent)."""
import json
import subprocess
import sys
import time

p = subprocess.Popen(
    ["./target/release/slim-atlas"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
    text=True,
    bufsize=1,
)


def call(mid, method, params=None):
    msg = {"jsonrpc": "2.0", "id": mid, "method": method}
    if params is not None:
        msg["params"] = params
    p.stdin.write(json.dumps(msg) + "\n")
    p.stdin.flush()
    while True:
        line = p.stdout.readline()
        if not line:
            return None
        line = line.strip()
        if not line.startswith("{"):
            continue
        d = json.loads(line)
        if d.get("id") == mid:
            return d


# handshake
call(1, "initialize", {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {"name": "verify", "version": "1"},
})
p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
p.stdin.flush()

# navigate
nav = call(2, "tools/call", {"name": "navigate", "arguments": {"url": "https://example.com/"}})
sid = json.loads(nav["result"]["content"][0]["text"])["session_id"]
print(f"navigate: top-level keys = {list(nav['result'].keys())}, has structuredContent = {'structuredContent' in nav['result']}")

# get_text / get_html / query
for i, (tool, args) in enumerate([
    ("get_text", {"session_id": sid}),
    ("get_html", {"session_id": sid}),
    ("query", {"session_id": sid, "selector": "h1"}),
]):
    r = call(3 + i, "tools/call", {"name": tool, "arguments": args})
    keys = list(r["result"].keys())
    has = "structuredContent" in r["result"]
    print(f"{tool}: keys = {keys}, has structuredContent = {has}")

p.stdin.close()
p.wait(timeout=3)
