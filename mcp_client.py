#!/usr/bin/env python3
"""Interactive CLI client for Slim Atlas MCP Server.

Communicates with the MCP server via JSON-RPC 2.0 over stdio.
"""

import json
import os
import subprocess
import sys
import threading
import time


# --- ANSI Colors ---


class Color:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RED = "\033[31m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    CYAN = "\033[36m"
    WHITE = "\033[37m"
    GRAY = "\033[90m"

    @staticmethod
    def supports_color():
        if not hasattr(sys.stdout, "isatty") or not sys.stdout.isatty():
            return False
        return os.environ.get("TERM") != "dumb"


USE_COLOR = Color.supports_color()


def c(color_code, text):
    if not USE_COLOR:
        return str(text)
    return f"{color_code}{text}{Color.RESET}"


# --- MCP Protocol Client ---


class MCPClient:
    def __init__(self, server_cmd):
        self.server_cmd = server_cmd
        self.proc = None
        self._id = 0
        self._lock = threading.Lock()
        self.tools = {}
        self._pending = {}
        self._pending_lock = threading.Lock()
        self.session_id = None
        self._log_buffer = []
        self._log_lock = threading.Lock()

    def _next_id(self):
        with self._lock:
            self._id += 1
            return self._id

    def start(self):
        self.proc = subprocess.Popen(
            self.server_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        threading.Thread(target=self._reader_loop, daemon=True).start()
        threading.Thread(target=self._stderr_loop, daemon=True).start()
        self._send("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "mcp-cli", "version": "1.0.0"},
        })
        self._send("notifications/initialized", {})
        self._fetch_tools()

    def _reader_loop(self):
        while True:
            try:
                line = self.proc.stdout.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                msg = json.loads(line)
                if "id" in msg:
                    with self._pending_lock:
                        self._pending[msg["id"]] = msg
            except Exception:
                break

    def _stderr_loop(self):
        for line in self.proc.stderr:
            line = line.rstrip()
            if line:
                with self._log_lock:
                    self._log_buffer.append(line)

    def _send(self, method, params):
        msg_id = self._next_id()
        request = {
            "jsonrpc": "2.0",
            "id": msg_id,
            "method": method,
            "params": params,
        }
        self.proc.stdin.write(json.dumps(request) + "\n")
        self.proc.stdin.flush()
        return msg_id

    def _send_and_wait(self, method, params):
        msg_id = self._send(method, params)
        while True:
            with self._pending_lock:
                if msg_id in self._pending:
                    return self._pending.pop(msg_id)
            time.sleep(0.05)

    def _fetch_tools(self):
        resp = self._send_and_wait("tools/list", {})
        if resp and "result" in resp:
            for tool in resp["result"].get("tools", []):
                self.tools[tool["name"]] = tool

    def call_tool(self, name, arguments=None):
        resp = self._send_and_wait("tools/call", {
            "name": name,
            "arguments": arguments or {},
        })
        if resp and "result" in resp:
            for item in resp["result"].get("content", []):
                if item.get("type") == "text":
                    self._extract_session_id(item.get("text", ""))
        return resp

    def _extract_session_id(self, text):
        import re
        match = re.search(r"\[(\w+):([^\]]+)\]", text)
        if match:
            self.session_id = match.group(2)

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def flush_logs(self):
        with self._log_lock:
            logs = self._log_buffer[:]
            self._log_buffer.clear()
        for line in logs:
            print(f"  {c(Color.GRAY, '[server]')} {c(Color.DIM, line)}")


# --- Commands ---


def cmd_help():
    print()
    print(c(Color.BOLD, "  Available commands:"))
    print()
    for name, desc in [
        ("help", "Show this help message"),
        ("list", "List all available MCP tools"),
        ("list <query>", "Filter tools by name"),
        ("nav <url>", "Navigate to URL (creates/reuses session)"),
        ("snap", "Take snapshot of current page (uses active session)"),
        ("run <tool> [args]", "Run a tool (prompts for missing required params)"),
        ("call <tool> <json>", "Run a tool with inline JSON arguments"),
        ("session", "Show current active session_id"),
        ("quit / exit", "Close the session and exit"),
    ]:
        print(f"    {c(Color.CYAN, name):<32} {c(Color.GRAY, desc)}")
    print()


def cmd_list(client, query=None):
    tools = client.tools
    if query:
        tools = {k: v for k, v in tools.items() if query.lower() in k.lower()}
    if not tools:
        print(c(Color.YELLOW, "  No tools found."))
        return
    print()
    for name, tool in tools.items():
        desc = tool.get("description", "No description")
        schema = tool.get("inputSchema", {})
        props = schema.get("properties", {})
        required = set(schema.get("required", []))
        print(f"  {c(Color.CYAN + Color.BOLD, name)}")
        print(f"    {c(Color.GRAY, desc)}")
        if props:
            for pname, pinfo in props.items():
                ptype = pinfo.get("type", "any")
                pdesc = pinfo.get("description", "")
                marker = c(Color.YELLOW, "*") if pname in required else c(Color.GRAY, " ")
                label = (c(Color.WHITE, pname) if pname in required
                         else c(Color.GRAY, pname))
                extra = f" -- {pdesc}" if pdesc else ""
                print(f"    {marker} {label} ({c(Color.DIM, ptype)}){extra}")
        print()


def cmd_run(client, tool_name, inline_args=""):
    if tool_name not in client.tools:
        print(c(Color.RED, f"  Unknown tool: {tool_name}"))
        print(c(Color.GRAY, "  Use 'list' to see available tools."))
        return
    tool = client.tools[tool_name]
    schema = tool.get("inputSchema", {})
    props = schema.get("properties", {})
    required = set(schema.get("required", []))
    print()
    print(c(Color.BOLD, f"  Running: {c(Color.CYAN, tool_name)}"))
    print(c(Color.GRAY, f"  {tool.get('description', '')}"))
    print()
    if not props:
        _print_result(client.call_tool(tool_name, {}), client)
        return
    required_params = [p for p in props if p in required]
    inline_tokens = inline_args.split() if inline_args else []
    provided = {}
    for i, token in enumerate(inline_tokens):
        if i < len(required_params):
            provided[required_params[i]] = token
    args = {}
    for pname, pinfo in props.items():
        ptype = pinfo.get("type", "string")
        pdesc = pinfo.get("description", "")
        is_required = pname in required
        if not is_required:
            continue
        label = f"{c(Color.YELLOW, '*')}{c(Color.WHITE, pname)}"
        hint = f" ({ptype})"
        if pdesc:
            hint += f" - {pdesc}"
        if "enum" in pinfo:
            hint += f" [{', '.join(pinfo['enum'])}]"
        if pname in provided:
            raw = provided[pname]
            print(f"    {c(Color.CYAN, pname)}: {raw} {c(Color.GRAY, '(from command line)')}")
        else:
            raw = input(f"    {label}{c(Color.DIM, hint)}: ").strip()
        if not raw:
            print(c(Color.RED, f"    Required parameter '{pname}' cannot be empty."))
            return
        if ptype in ("number", "integer"):
            try:
                args[pname] = int(raw) if ptype == "integer" else float(raw)
            except ValueError:
                print(c(Color.RED, f"    Invalid number for '{pname}': {raw}"))
                return
        elif ptype == "boolean":
            args[pname] = raw.lower() in ("true", "1", "yes", "y")
        else:
            args[pname] = raw
    print()
    _print_result(client.call_tool(tool_name, args), client)


def cmd_call(client, tool_name, json_args=""):
    if tool_name not in client.tools:
        print(c(Color.RED, f"  Unknown tool: {tool_name}"))
        print(c(Color.GRAY, "  Use 'list' to see available tools."))
        return
    args = {}
    if json_args.strip():
        try:
            args = json.loads(json_args)
        except json.JSONDecodeError as e:
            print(c(Color.RED, f"  Invalid JSON: {e}"))
            return
    _print_result(client.call_tool(tool_name, args), client)


def _print_result(resp, client=None):
    if client:
        client.flush_logs()
    if "error" in resp:
        err = resp["error"]
        print(c(Color.RED, f"  Error [{err.get('code', '?')}]: {err.get('message', 'Unknown')}"))
        return
    result = resp.get("result", {})
    for item in result.get("content", []):
        if item.get("type") == "text":
            for line in item.get("text", "").split("\n"):
                print(f"  {c(Color.GREEN, line)}")
        elif item.get("type") == "image":
            print(c(Color.CYAN, "  [image data]"))
        else:
            print(c(Color.GRAY, f"  [{item.get('type', '?')}]"))
    print()


# --- Main ---


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    server_script = os.path.join(script_dir, "src", "index.ts")
    if not os.path.exists(server_script):
        print(c(Color.RED, f"  Server script not found: {server_script}"))
        sys.exit(1)
    print(c(Color.BOLD, "  Slim Atlas MCP CLI Client"))
    print(c(Color.GRAY, "  Connecting to server..."))
    client = MCPClient(["npx", "tsx", server_script])
    try:
        client.start()
    except Exception as e:
        print(c(Color.RED, f"  Failed to start server: {e}"))
        sys.exit(1)
    print(c(Color.GREEN, "  Connected! Type 'help' for commands."))
    print()
    try:
        while True:
            try:
                line = input(c(Color.BOLD + Color.WHITE, "mcp> ")).strip()
            except EOFError:
                break
            if not line:
                continue
            parts = line.split(None, 2)
            cmd = parts[0].lower()
            if cmd in ("quit", "exit", "q"):
                break
            elif cmd == "help":
                cmd_help()
            elif cmd == "list":
                cmd_list(client, parts[1] if len(parts) > 1 else None)
            elif cmd == "run":
                if len(parts) < 2:
                    print(c(Color.RED, "  Usage: run <tool_name> [args]"))
                else:
                    tool_parts = parts[1].split(None, 1)
                    cmd_run(client, tool_parts[0], tool_parts[1] if len(tool_parts) > 1 else "")
            elif cmd == "nav":
                if len(parts) < 2:
                    print(c(Color.RED, "  Usage: nav <url>"))
                else:
                    args = {"url": parts[1]}
                    if client.session_id:
                        args["session_id"] = client.session_id
                    _print_result(client.call_tool("browser_navigate", args), client)
            elif cmd == "snap":
                if not client.session_id:
                    print(c(Color.RED, "  No active session. Run 'nav <url>' first."))
                else:
                    _print_result(client.call_tool("browser_snapshot", {"session_id": client.session_id}), client)
            elif cmd == "session":
                if client.session_id:
                    print(f"  {c(Color.GREEN, client.session_id)}")
                else:
                    print(c(Color.GRAY, "  No active session."))
            elif cmd == "call":
                if len(parts) < 2:
                    print(c(Color.RED, "  Usage: call <tool_name> <json_args>"))
                else:
                    cmd_call(client, parts[1], parts[2] if len(parts) > 2 else "")
            elif cmd in client.tools:
                cmd_run(client, cmd, parts[1] if len(parts) > 1 else "")
            else:
                print(c(Color.GRAY, f"  Unknown command: {cmd}. Type 'help' for commands."))
    except KeyboardInterrupt:
        print()
    finally:
        print(c(Color.GRAY, "  Disconnecting..."))
        client.stop()
        print(c(Color.GREEN, "  Done."))


if __name__ == "__main__":
    main()
