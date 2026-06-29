#!/usr/bin/env -S uv run --script --directory ..
# /// script
# requires-python = ">=3.10"
# dependencies = ["langchain-mcp-adapters"]
# ///
"""Interactive CLI client for SlimAtlas MCP Server.

Uses langchain-mcp-adapters (MultiServerMCPClient) to talk to the server.
Default transport: stdio (spawns `npx tsx src/index.ts`). Use --http to connect
to a running standalone server instead.

Run via:
  uv run scripts/mcp_client.py                          # stdio
  uv run scripts/mcp_client.py --http http://localhost:8080/mcp --token s3cret
"""

import argparse
import asyncio
import os
import re
import sys

from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools


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
    return f"{color_code}{text}{Color.RESET}" if USE_COLOR else str(text)


# --- Connection builders ---


def stdio_connection(repo_root: str) -> dict:
    return {
        "default": {
            "transport": "stdio",
            "command": "npx",
            "args": ["tsx", "src/index.ts"],
            "cwd": repo_root,
        }
    }


def http_connection(url: str, token: str | None) -> dict:
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return {
        "default": {
            "transport": "streamable_http",
            "url": url,
            "headers": headers,
        }
    }


# --- REPL ---


SESS_ID_RE = re.compile(r"\[(\w+):([^\]]+)\]")


async def repl_loop(tools: dict, session_id_holder: list):
    """Interactive loop. Runs inside the MCP session context so the same
    subprocess/HTTP connection is reused for every tool call."""
    print(c(Color.GREEN, f"  Connected! {len(tools)} tools available. Type 'help' for commands."))
    print()
    while True:
        try:
            line = await asyncio.to_thread(input, c(Color.BOLD + Color.WHITE, "mcp> "))
        except (EOFError, KeyboardInterrupt):
            print()
            return
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 2)
        cmd = parts[0].lower()
        if cmd in ("quit", "exit", "q"):
            return
        elif cmd == "help":
            cmd_help(tools)
        elif cmd == "list":
            cmd_list(tools, parts[1] if len(parts) > 1 else None)
        elif cmd == "session":
            print(f"  {c(Color.GREEN, session_id_holder[0] or '(none)')}")
        elif cmd == "nav":
            if len(parts) < 2:
                print(c(Color.RED, "  Usage: nav <url>"))
            else:
                args = {"url": parts[1]}
                if session_id_holder[0]:
                    args["session_id"] = session_id_holder[0]
                await invoke(tools, "browser_navigate", args, session_id_holder)
        elif cmd == "snap":
            if not session_id_holder[0]:
                print(c(Color.RED, "  No active session. Run 'nav <url>' first."))
            else:
                await invoke(tools, "browser_snapshot", {"session_id": session_id_holder[0]}, session_id_holder)
        elif cmd == "call":
            if len(parts) < 2:
                print(c(Color.RED, "  Usage: call <tool_name> <json_args>"))
            else:
                import json
                try:
                    args = json.loads(parts[2]) if len(parts) > 2 else {}
                except json.JSONDecodeError as e:
                    print(c(Color.RED, f"  Invalid JSON: {e}"))
                    continue
                await invoke(tools, parts[1], args, session_id_holder)
        elif cmd in tools:
            inline = " ".join(parts[1:]) if len(parts) > 1 else ""
            args = await prompt_for_args(tools[cmd], inline)
            if args is not None:
                await invoke(tools, cmd, args, session_id_holder)
        else:
            print(c(Color.GRAY, f"  Unknown command: {cmd}. Type 'help' for commands."))


def cmd_help(tools):
    print()
    print(c(Color.BOLD, "  Available commands:"))
    print()
    for name, desc in [
        ("help", "Show this help message"),
        ("list", "List all available MCP tools"),
        ("list <query>", "Filter tools by name"),
        ("nav <url>", "Navigate to URL (creates/reuses session)"),
        ("snap", "Take snapshot of current page (uses active session)"),
        ("<tool_name> [args]", "Call a tool by name (prompts for missing params)"),
        ("call <tool> <json>", "Run a tool with inline JSON arguments"),
        ("session", "Show current active session_id"),
        ("quit / exit", "Close the session and exit"),
    ]:
        print(f"    {c(Color.CYAN, name):<32} {c(Color.GRAY, desc)}")
    print()


def cmd_list(tools, query=None):
    items = list(tools.values())
    if query:
        items = [t for t in items if query.lower() in t.name.lower()]
    if not items:
        print(c(Color.YELLOW, "  No tools found."))
        return
    print()
    for t in items:
        print(f"  {c(Color.CYAN + Color.BOLD, t.name)}")
        print(f"    {c(Color.GRAY, t.description)}")
        schema = t.args_schema
        properties = schema.get("properties", {})
        required = set(schema.get("required", []))
        for fname, prop in properties.items():
            is_required = fname in required
            marker = c(Color.YELLOW, "*") if is_required else c(Color.GRAY, " ")
            label = c(Color.WHITE, fname) if is_required else c(Color.GRAY, fname)
            ftype = prop.get("type", "any")
            desc = prop.get("description", "")
            extra = f" -- {desc}" if desc else ""
            print(f"    {marker} {label} ({c(Color.DIM, str(ftype))}){extra}")
        print()


async def prompt_for_args(tool, inline: str) -> dict | None:
    """Parse inline args (positional, required-only) then prompt for missing required."""
    schema = tool.args_schema
    properties = schema.get("properties", {})
    required = set(schema.get("required", []))
    required_names = [name for name in properties if name in required]
    inline_tokens = inline.split() if inline else []
    provided = {}
    for i, tok in enumerate(inline_tokens):
        if i < len(required_names):
            provided[required_names[i]] = tok
    args = {}
    for fname, prop in properties.items():
        ptype = prop.get("type", "string")
        is_required = fname in required
        if fname in provided:
            raw = provided[fname]
            print(f"    {c(Color.CYAN, fname)}: {raw} {c(Color.GRAY, '(from command line)')}")
        elif is_required:
            desc = prop.get("description", "")
            prompt = f"    {c(Color.YELLOW, '*')}{c(Color.WHITE, fname)}{c(Color.DIM, f' ({ptype})' + (f' - {desc}' if desc else ''))}: "
            try:
                raw = await asyncio.to_thread(input, prompt)
            except (EOFError, KeyboardInterrupt):
                return None
            raw = raw.strip()
            if not raw:
                print(c(Color.RED, f"    Required parameter '{fname}' cannot be empty."))
                return None
        else:
            continue
        # coerce using JSON Schema type
        if ptype == "integer":
            args[fname] = int(raw)
        elif ptype == "number":
            args[fname] = float(raw)
        elif ptype == "boolean":
            args[fname] = raw.lower() in ("true", "1", "yes", "y")
        else:
            args[fname] = raw
    return args


async def invoke(tools, name: str, args: dict, session_id_holder: list):
    if name not in tools:
        print(c(Color.RED, f"  Unknown tool: {name}"))
        return
    print()
    try:
        result = await tools[name].ainvoke(args)
    except Exception as e:
        print(c(Color.RED, f"  Error: {e}"))
        return
    text = str(result) if result is not None else ""
    # capture session id from output
    m = SESS_ID_RE.search(text)
    if m:
        session_id_holder[0] = m.group(2)
    for line in text.split("\n"):
        print(f"  {c(Color.GREEN, line)}")
    print()


# --- Main ---


async def main():
    parser = argparse.ArgumentParser(description="SlimAtlas MCP CLI Client")
    parser.add_argument("--http", metavar="URL", help="Connect to standalone HTTP server (e.g. http://localhost:8080/mcp)")
    parser.add_argument("--token", metavar="TOKEN", help="Bearer token for HTTP auth")
    args = parser.parse_args()

    mode = "http" if args.http else "stdio"
    print(c(Color.BOLD, "  SlimAtlas MCP CLI Client"))
    print(c(Color.GRAY, f"  Transport: {mode}"))
    if args.http:
        print(c(Color.GRAY, f"  Endpoint:  {args.http}"))
    print(c(Color.GRAY, "  Connecting..."))

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if args.http:
        connections = http_connection(args.http, args.token)
    else:
        connections = stdio_connection(repo_root)

    try:
        client = MultiServerMCPClient(connections)
        async with client.session("default") as session:
            tools_list = await load_mcp_tools(session)
            tools = {t.name: t for t in tools_list}
            session_id_holder = [None]
            await repl_loop(tools, session_id_holder)
    except Exception as e:
        print(c(Color.RED, f"  Failed: {e}"))
        sys.exit(1)
    print(c(Color.GRAY, "  Disconnected."))


if __name__ == "__main__":
    asyncio.run(main())
