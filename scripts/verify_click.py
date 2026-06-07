"""Verify the new `click` tool works end-to-end via the wire."""
import json
import subprocess
import sys
import time

# Spin up a minimal Python HTTP server with two pages where the second has
# a link to a third, just to confirm click follows a link.
import http.server
import socketserver
import threading

PORT = 18080


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/" or self.path == "/index":
            body = b'<!doctype html><html><head><title>Index</title></head><body><a href="/page-two">Two</a></body></html>'
        elif self.path == "/page-two":
            body = b'<!doctype html><html><head><title>Two</title></head><body><h1>Two</h1></body></html>'
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


httpd = socketserver.TCPServer(("127.0.0.1", PORT), Handler)
t = threading.Thread(target=httpd.serve_forever, daemon=True)
t.start()
time.sleep(0.2)

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


call(1, "initialize", {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {"name": "verify-click", "version": "1"},
})
p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
p.stdin.flush()

# List tools to confirm click is registered
tools = call(2, "tools/list")["result"]["tools"]
click_tool = next((t for t in tools if t["name"] == "click"), None)
print(f"click tool registered: {click_tool is not None}")
if click_tool:
    print(f"  description: {click_tool['description'][:80]}...")

# Navigate to the index
nav = call(3, "tools/call", {"name": "navigate", "arguments": {"url": f"http://127.0.0.1:{PORT}/"}})
sid = json.loads(nav["result"]["content"][0]["text"])["session_id"]
print(f"navigate: session_id={sid}")

# Click the link
click_result = call(4, "tools/call", {
    "name": "click",
    "arguments": {"session_id": sid, "selector": "a[href='/page-two']"},
})
out = json.loads(click_result["result"]["content"][0]["text"])
print(f"click: success={out['success']}, new_url={out['new_url']}, elapsed_ms={out['elapsed_ms']}")
assert out["success"], "click should succeed"
assert out["new_url"] == f"http://127.0.0.1:{PORT}/page-two", f"unexpected new_url: {out['new_url']}"

# Verify get_text returns the new page
get_text = call(5, "tools/call", {"name": "get_text", "arguments": {"session_id": sid}})
text = json.loads(get_text["result"]["content"][0]["text"])["text"]
print(f"get_text after click contains 'Two': {'Two' in text}")
assert "Two" in text, f"get_text should contain 'Two', got: {text}"

# Try clicking a button — should return SelectorNotFound
button_result = call(6, "tools/call", {
    "name": "click",
    "arguments": {"session_id": sid, "selector": "button"},
})
err = button_result.get("error")
if err:
    print(f"click button: error code={err['code']}, message={err['message'][:80]}...")
    assert err["code"] == -32602, f"expected -32602, got {err['code']}"
else:
    print(f"click button: unexpected result {button_result['result']}")
    sys.exit(1)

p.stdin.close()
p.wait(timeout=3)
httpd.shutdown()

print("\nAll checks passed.")
