#!/usr/bin/env python3
"""Interactive CLI for slim-atlas.

Default: REPL when run with no args.
One-shot: any positional arg triggers a one-shot command (legacy test_client behaviour).

Examples:
    python3 test_client.py                                  # interactive REPL
    python3 test_client.py navigate https://example.com/   # one-shot navigate
    python3 test_client.py --server ./target/debug/slim-atlas

Inside the REPL:
    list                              List available tools
    schema <tool>                     Show input/output schema for a tool
    call <tool> '<json>'              Call any tool with raw JSON arguments
    navigate <url> [session_id]       Shortcut for `call navigate`
    click <session_id> <selector>     Shortcut for `call click` (T1: `<a href>` only)
    get_text <session_id> [selector]  Shortcut for `call get_text`
    get_html <session_id> [selector]  Shortcut for `call get_html`
    query <session_id> <selector>     Shortcut for `call query`
    raw '<json>'                      Send a raw JSON-RPC message
    mode <full|text>                  Switch output verbosity
    help                              Show this help
    quit / exit                       Disconnect and exit

The default output mode is `full` (the exact JSON-RPC response the agent
sees, pretty-printed). `text` shows just `content[0].text` (which for
slim-atlas is itself a JSON string of the tool's typed output). There is
no `structured` mode — slim-atlas returns only `content[0].text`, not the
duplicated `content` + `structuredContent` pair.
"""
from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
import threading

DEFAULT_SERVER = "./target/release/slim-atlas"
DEBUG_SERVER = "./target/debug/slim-atlas"

MODES = ("full", "text")


class Client:
    def __init__(self, server_path: str):
        self.proc = subprocess.Popen(
            [server_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self.cond = threading.Condition()
        self.replies: dict = {}
        self._next_id = 1
        self._reader_thread = threading.Thread(target=self._reader, daemon=True)
        self._reader_thread.start()
        self.handshake()

    def _reader(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" not in msg:
                continue
            with self.cond:
                self.replies[msg["id"]] = msg
                self.cond.notify_all()

    def _send(self, method: str, params=None, notification=False) -> int | None:
        with self.cond:
            msg = {"jsonrpc": "2.0", "method": method}
            if not notification:
                msg["id"] = self._next_id
                self._next_id += 1
            if params is not None:
                msg["params"] = params
            self.proc.stdin.write(json.dumps(msg) + "\n")
            self.proc.stdin.flush()
            return msg.get("id")

    def request(self, method: str, params=None) -> dict:
        with self.cond:
            my_id = self._next_id
            self._next_id += 1
            msg = {"jsonrpc": "2.0", "id": my_id, "method": method}
            if params is not None:
                msg["params"] = params
            self.proc.stdin.write(json.dumps(msg) + "\n")
            self.proc.stdin.flush()
            self.cond.wait_for(lambda: my_id in self.replies)
            return self.replies.pop(my_id)

    def notify(self, method: str, params=None):
        self._send(method, params, notification=True)

    def handshake(self):
        self.request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "slim-atlas-cli", "version": "0.1"},
        })
        self.notify("notifications/initialized")

    def call_tool(self, name: str, arguments: dict) -> dict:
        return self.request("tools/call", {"name": name, "arguments": arguments})

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        self.proc.wait(timeout=3)


def render(reply: dict, mode: str = "full") -> str:
    """Render an MCP reply in the requested verbosity mode."""
    if "error" in reply:
        return f"ERROR {reply['error'].get('code')}: {reply['error'].get('message')}"

    result = reply.get("result", {})

    if mode == "text":
        content = result.get("content", [])
        if not content:
            return "(no content)"
        out = []
        for c in content:
            if c.get("type") == "text":
                text = c.get("text", "")
                # Tools return JSON inside text — try to pretty-print.
                try:
                    out.append(json.dumps(json.loads(text), indent=2))
                except (json.JSONDecodeError, TypeError):
                    out.append(text)
        return "\n--\n".join(out)

    # full (default)
    return json.dumps(reply, indent=2)


HELP_TEXT = """\
Commands:
  list                              List available tools
  schema <tool>                     Show input/output schema for a tool
  call <tool> '<json>'              Call any tool with raw JSON arguments
  navigate <url> [session_id]       Shortcut for `call navigate`
  click <session_id> <selector>     Shortcut for `call click` (T1: `<a href>` only)
  get_text <session_id> [selector]  Shortcut for `call get_text`
  get_html <session_id> [selector]  Shortcut for `call get_html`
  query <session_id> <selector>     Shortcut for `call query`
  raw '<json>'                      Send a raw JSON-RPC message
  mode <full|text>                  Switch output verbosity (default: full)
  help                              Show this help
  quit / exit                       Disconnect and exit

Examples:
  list
  navigate https://example.com/
  navigate https://example.com/ 6d2079a4-29a0-4308-a9fb-9cf31ff38738
  click <session> "a[href='/about']"
  query <session> "h1"
  get_text <session> "main"
  call navigate '{"url":"https://example.com/"}'
  raw '{"jsonrpc":"2.0","id":99,"method":"tools/list"}'
"""


def repl(client: Client, initial_mode: str):
    mode = initial_mode
    print(f"test_client — type `help` for commands, `quit` to exit. mode={mode}")

    def do_list(_args):
        reply = client.request("tools/list")
        if "error" in reply:
            print(render(reply, mode))
            return
        tools = reply["result"]["tools"]
        print(f"{len(tools)} tools:")
        for t in tools:
            desc = (t.get("description") or "").split("\n")[0]
            print(f"  {t['name']:<12} {desc}")

    def do_schema(args):
        if not args:
            print("usage: schema <tool>")
            return
        name = args[0]
        reply = client.request("tools/list")
        if "error" in reply:
            print(render(reply, mode))
            return
        for t in reply["result"]["tools"]:
            if t["name"] == name:
                print(json.dumps(t, indent=2))
                return
        print(f"no such tool: {name}")

    def do_call(args):
        if len(args) < 2:
            print("usage: call <tool> '<json-arguments>'")
            return
        name = args[0]
        try:
            arguments = json.loads(" ".join(args[1:]))
        except json.JSONDecodeError as e:
            print(f"invalid JSON: {e}")
            return
        reply = client.call_tool(name, arguments)
        print(render(reply, mode))

    def do_navigate(args):
        if not args:
            print("usage: navigate <url> [session_id]")
            return
        arguments = {"url": args[0]}
        if len(args) > 1:
            arguments["session_id"] = args[1]
        reply = client.call_tool("navigate", arguments)
        print(render(reply, mode))

    def do_click(args):
        if len(args) < 2:
            print("usage: click <session_id> <selector>")
            return
        arguments = {"session_id": args[0], "selector": args[1]}
        reply = client.call_tool("click", arguments)
        print(render(reply, mode))

    def do_text_tool(tool_name: str, args, need_selector=False):
        if len(args) < 1:
            print(f"usage: {tool_name} <session_id> [selector]")
            return
        arguments = {"session_id": args[0]}
        if len(args) > 1:
            arguments["selector"] = args[1]
        reply = client.call_tool(tool_name, arguments)
        print(render(reply, mode))

    def do_query(args):
        if len(args) < 2:
            print("usage: query <session_id> <selector>")
            return
        arguments = {"session_id": args[0], "selector": args[1]}
        reply = client.call_tool("query", arguments)
        print(render(reply, mode))

    def do_raw(args):
        if not args:
            print("usage: raw '<jsonrpc message>'")
            return
        try:
            msg = json.loads(" ".join(args))
        except json.JSONDecodeError as e:
            print(f"invalid JSON: {e}")
            return
        # If it's a request (has id), do a proper request/response.
        # Otherwise just send it.
        if "id" in msg:
            with client.cond:
                my_id = msg["id"]
                client.proc.stdin.write(json.dumps(msg) + "\n")
                client.proc.stdin.flush()
                client.cond.wait_for(lambda: my_id in client.replies)
                print(render(client.replies.pop(my_id), mode))
        else:
            client.proc.stdin.write(json.dumps(msg) + "\n")
            client.proc.stdin.flush()
            print("(notification sent)")

    def do_mode(args):
        if not args or args[0] not in MODES:
            print(f"usage: mode <{'|'.join(MODES)}>")
            return
        nonlocal mode
        mode = args[0]
        print(f"mode={mode}")

    def do_help(_args):
        print(HELP_TEXT)

    def do_quit(_args):
        return True

    commands = {
        "list": do_list,
        "tools": do_list,
        "schema": do_schema,
        "call": do_call,
        "navigate": do_navigate,
        "click": do_click,
        "get_text": lambda a: do_text_tool("get_text", a),
        "get_html": lambda a: do_text_tool("get_html", a),
        "query": do_query,
        "raw": do_raw,
        "mode": do_mode,
        "help": do_help,
        "?": do_help,
        "quit": do_quit,
        "exit": do_quit,
        "q": do_quit,
    }

    while True:
        try:
            line = input("> ")
        except (EOFError, KeyboardInterrupt):
            print()
            break
        line = line.strip()
        if not line:
            continue
        try:
            parts = shlex.split(line)
        except ValueError as e:
            print(f"parse error: {e}")
            continue
        cmd, args = parts[0], parts[1:]
        handler = commands.get(cmd)
        if handler is None:
            print(f"unknown command: {cmd!r}. type `help`.")
            continue
        if handler(args):
            break


def one_shot(client: Client, argv: list, mode: str):
    """One-shot mode: argv is e.g. ['navigate', 'https://example.com/']."""
    cmd = argv[0]
    args = argv[1:]
    if cmd == "list" or cmd == "tools":
        reply = client.request("tools/list")
        print(render(reply, mode))
    elif cmd == "navigate":
        if not args:
            print("usage: navigate <url> [session_id]", file=sys.stderr)
            return 2
        arguments = {"url": args[0]}
        if len(args) > 1:
            arguments["session_id"] = args[1]
        print(render(client.call_tool("navigate", arguments), mode))
    elif cmd == "click":
        if len(args) < 2:
            print("usage: click <session_id> <selector>", file=sys.stderr)
            return 2
        print(render(
            client.call_tool("click", {"session_id": args[0], "selector": args[1]}),
            mode,
        ))
    elif cmd in ("get_text", "get_html"):
        if not args:
            print(f"usage: {cmd} <session_id> [selector]", file=sys.stderr)
            return 2
        arguments = {"session_id": args[0]}
        if len(args) > 1:
            arguments["selector"] = args[1]
        print(render(client.call_tool(cmd, arguments), mode))
    elif cmd == "query":
        if len(args) < 2:
            print("usage: query <session_id> <selector>", file=sys.stderr)
            return 2
        print(render(
            client.call_tool("query", {"session_id": args[0], "selector": args[1]}),
            mode,
        ))
    elif cmd == "call":
        if len(args) < 2:
            print("usage: call <tool> '<json>'", file=sys.stderr)
            return 2
        try:
            arguments = json.loads(" ".join(args[1:]))
        except json.JSONDecodeError as e:
            print(f"invalid JSON: {e}", file=sys.stderr)
            return 2
        print(render(client.call_tool(args[0], arguments), mode))
    else:
        print(f"unknown one-shot command: {cmd!r}", file=sys.stderr)
        return 2
    return 0


def main():
    ap = argparse.ArgumentParser(
        prog="test_client",
        description="Interactive CLI / one-shot tool invoker for slim-atlas.",
    )
    ap.add_argument(
        "--server",
        default=None,
        help=f"path to slim-atlas binary (default: {DEFAULT_SERVER} if it exists, else {DEBUG_SERVER})",
    )
    ap.add_argument(
        "--mode",
        choices=MODES,
        default="full",
        help="output verbosity (default: full — the raw JSON-RPC response)",
    )
    ap.add_argument(
        "command",
        nargs="*",
        help="optional one-shot command (e.g. `navigate <url>`). If omitted, start REPL.",
    )
    args = ap.parse_args()

    server = args.server
    if server is None:
        import os
        server = DEFAULT_SERVER if os.path.exists(DEFAULT_SERVER) else DEBUG_SERVER

    client = Client(server)
    try:
        if args.command:
            sys.exit(one_shot(client, args.command, args.mode))
        else:
            repl(client, args.mode)
    finally:
        client.close()


if __name__ == "__main__":
    main()
