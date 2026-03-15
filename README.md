# SlimAtlas

A Model Context Protocol (MCP) server that provides browser automation capabilities using Lightpanda browser. This server enables LLMs to interact with web pages through browser automation.

## Features

- **Browser Automation**: Navigate, click, type, fill forms, and evaluate JavaScript
- **Page Snapshots**: Get accessibility tree snapshots of pages
- **Screenshots**: Capture full page or viewport screenshots
- **History Navigation**: Go back, go forward, and reload pages
- **HTML Extraction**: Get page HTML content
- **Lightweight**: Uses Lightpanda browser (9x less memory than Chrome, 11x faster)

## Installation

```bash
# Install dependencies
bun install

# Download Lightpanda browser (required)
# For Linux x86_64:
curl -L -o lightpanda https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-x86_64-linux && chmod a+x ./lightpanda

# For MacOS aarch64 (Apple Silicon):
curl -L -o lightpanda https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-aarch64-macos && chmod a+x ./lightpanda

# For MacOS x86_64:
curl -L -o lightpanda https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-x86_64-macos && chmod a+x ./lightpanda
```

## Usage

### Run the MCP Server

```bash
# Run with bun
bun run src/index.ts
```

### Configuration

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "slimatlas": {
      "command": "bun",
      "args": ["run", "src/index.ts"]
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_snapshot` | Get accessibility snapshot |
| `browser_click` | Click an element |
| `browser_type` | Type text into an element |
| `browser_fill` | Fill an input with a value |
| `browser_evaluate` | Evaluate JavaScript |
| `browser_screenshot` | Take a screenshot |
| `browser_get_html` | Get page HTML |
| `browser_go_back` | Navigate back |
| `browser_go_forward` | Navigate forward |
| `browser_reload` | Reload the page |
| `browser_get_page_info` | Get page info |
| `browser_close` | Close the browser |
| `browser_install` | Install browser |

## Running Tests

```bash
# Run all tests
bun test

# Run tests in watch mode
bun test --watch
```

## Project Structure

```
slimatlas/
├── src/
│   ├── index.ts       # Main entry point
│   ├── server.ts      # MCP server implementation
│   ├── browser.ts     # Browser manager
│   └── types.ts       # Type definitions
├── test/
│   ├── server.test.ts     # Server tests
│   ├── integration.test.ts # Integration tests
│   └── mcp.test.ts        # MCP protocol tests
├── lightpanda         # Lightpanda browser binary
└── package.json
```

## Requirements

- Bun runtime
- Node.js 18+
- Lightpanda browser (downloads automatically or manually)

## License

MIT
