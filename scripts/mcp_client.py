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
import time

from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools
from langchain_core.messages import ToolMessage
from langchain_core.messages.utils import count_tokens_approximately


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


def fmt_time(seconds: float) -> str:
    if seconds >= 1:
        return f"({seconds:.2f}s)"
    return f"({seconds * 1000:.0f}ms)"


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


def _extract_text_from_blocks(blocks) -> str:
    """Join text from a list of content blocks (dicts or strings)."""
    parts = []
    for block in blocks:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
        elif isinstance(block, str):
            parts.append(block)
    return "\n".join(parts)


def parse_result_text(result) -> str:
    """Extract the plain text string from a langchain MCP tool result."""
    if result is None:
        return ""
    # list of content blocks (direct return from StructuredTool.ainvoke)
    if isinstance(result, list):
        return _extract_text_from_blocks(result) or str(result)
    # AIMessage or ToolMessage: content is list of blocks
    if hasattr(result, "content"):
        content = result.content
        if isinstance(content, list):
            text = _extract_text_from_blocks(content)
            if text:
                return text
        if isinstance(content, str):
            return content
    return str(result)


def format_snapshot(body: str) -> str:
    """Render an accessibility tree as a colored tree with box-drawing chars."""
    lines = []
    for raw_line in body.split("\n"):
        stripped = raw_line.lstrip()
        if not stripped.startswith("- "):
            # non-tree line (e.g. format explanation) — dim it
            lines.append(c(Color.GRAY, f"  {raw_line}"))
            continue

        indent = (len(raw_line) - len(stripped)) // 2
        node_text = stripped[2:]  # strip "- "

        # build connector
        if indent > 0:
            connector = "│   " * (indent - 1) + "├── "
        else:
            connector = ""

        # parse type, quoted text, #id
        node_type = ""
        display_text = ""
        node_id = ""
        rest = node_text

        # extract type (first token)
        parts = rest.split(None, 1)
        if parts:
            node_type = parts[0]
            rest = parts[1] if len(parts) > 1 else ""

        # extract quoted text
        if rest.startswith('"'):
            end_q = rest.find('"', 1)
            if end_q != -1:
                display_text = rest[1:end_q]
                rest = rest[end_q + 1:].lstrip()
            else:
                display_text = rest[1:]
                rest = ""

        # extract #id
        id_match = re.match(r"#(\d+)", rest)
        if id_match:
            node_id = id_match.group(1)

        # color by type
        if node_type.startswith("heading_"):
            type_str = c(Color.BOLD + Color.WHITE, node_type)
        elif node_type == "link":
            type_str = c(Color.CYAN, node_type)
        elif node_type == "button":
            type_str = c(Color.YELLOW, node_type)
        elif node_type in ("textbox", "combobox", "searchbox", "checkbox", "radio", "slider", "spinbutton", "option"):
            type_str = c(Color.GREEN, node_type)
        elif node_type == "image":
            type_str = c(Color.DIM, node_type)
        elif node_type in ("list", "table", "row", "cell", "columnheader", "listitem",
                           "contentinfo", "banner", "navigation", "form", "group", "dialog", "label"):
            type_str = c(Color.GRAY, node_type)
        else:
            type_str = c(Color.WHITE, node_type)

        # build line parts
        parts_out = [connector, type_str]
        if display_text:
            escaped = display_text.replace("\\", "\\\\").replace('"', '\\"')
            # trim if very long
            if len(escaped) > 120:
                escaped = escaped[:117] + "..."
            parts_out.append(f' "{c(Color.WHITE, escaped)}"')
        if node_id:
            parts_out.append(f" {c(Color.BOLD + Color.RED, f'#{node_id}')}")

        lines.append("  " + "".join(parts_out))

    return "\n".join(lines)


def format_generic(body: str) -> str:
    """Format a non-snapshot tool result."""
    return c(Color.GREEN, body)


async def invoke(tools, name: str, args: dict, session_id_holder: list):
    if name not in tools:
        print(c(Color.RED, f"  Unknown tool: {name}"))
        return
    print()
    t0 = time.monotonic()
    try:
        result = await tools[name].ainvoke(args)
    except Exception as e:
        elapsed = time.monotonic() - t0
        print(c(Color.RED, f"  Error: {e} {c(Color.GRAY, fmt_time(elapsed))}"))
        return
    elapsed = time.monotonic() - t0
    raw = parse_result_text(result)

    # extract session_id and body from server format: "session_id: X\nresult: Y"
    session_id = ""
    body = raw
    m = re.match(r"session_id:\s*(\S+)\nresult:\s*", raw)
    if m:
        session_id = m.group(1)
        body = raw[m.end():]
    else:
        # fallback: old bracket format
        m2 = SESS_ID_RE.search(raw)
        if m2:
            session_id = m2.group(2)

    if session_id:
        session_id_holder[0] = session_id
        print(f"  {c(Color.GRAY, f'session: {session_id}')}")

    # detect snapshot (accessibility tree lines start with "- type")
    is_snapshot = any(line.lstrip().startswith("- ") and re.match(r"- \w", line.lstrip())
                      for line in body.split("\n")[:5])

    if is_snapshot:
        print(format_snapshot(body))
        tokens = count_tokens_approximately([ToolMessage(content=body, tool_call_id="snapshot")])
        stats = f"{fmt_time(elapsed)} ~{tokens} tokens"
    else:
        print(format_generic(body))
        stats = fmt_time(elapsed)
    print(f"  {c(Color.GRAY, stats)}")
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
