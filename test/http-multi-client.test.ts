import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import net from 'net';
import { PuppeteerMCPServer } from '../src/server.js';

// Regression: a single shared MCP Server was reused across HTTP connections, so
// the second client got "Already connected to a transport". Now each connection
// builds its own Server. This connects two clients in parallel and lists tools.
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

describe('HTTP multi-client (streamable HTTP)', () => {
  let server: PuppeteerMCPServer;
  let port: number;
  let prevPort: string | undefined;
  let prevHost: string | undefined;
  let prevToken: string | undefined;
  let prevPlugins: string | undefined;
  let clients: Client[] = [];

  beforeAll(async () => {
    port = await freePort();
    prevPort = process.env.MCP_PORT;
    prevHost = process.env.MCP_HOST;
    prevToken = process.env.MCP_AUTH_TOKEN;
    prevPlugins = process.env.PLUGINS;
    process.env.MCP_TRANSPORT = 'http';
    process.env.MCP_PORT = String(port);
    process.env.MCP_HOST = '127.0.0.1';
    process.env.PLUGINS = 'document-export';
    delete process.env.MCP_AUTH_TOKEN;

    server = new PuppeteerMCPServer();
    await server.run();

    // runHttp() doesn't await listen(); wait until the socket accepts.
    await new Promise<void>((resolve, reject) => {
      const probe = net.connect(port, '127.0.0.1');
      probe.once('connect', () => { probe.destroy(); resolve(); });
      probe.once('error', reject);
    });
  });

  afterAll(async () => {
    for (const c of clients) {
      try { await c.close(); } catch { /* best-effort */ }
    }
    clients = [];
    await server.shutdown();
    if (prevPort === undefined) delete process.env.MCP_PORT; else process.env.MCP_PORT = prevPort;
    if (prevHost === undefined) delete process.env.MCP_HOST; else process.env.MCP_HOST = prevHost;
    if (prevToken === undefined) delete process.env.MCP_AUTH_TOKEN; else process.env.MCP_AUTH_TOKEN = prevToken;
    if (prevPlugins === undefined) delete process.env.PLUGINS; else process.env.PLUGINS = prevPlugins;
    delete process.env.MCP_TRANSPORT;
  });

  it('two clients connect, initialize, and list tools concurrently', async () => {
    const mkClient = async () => {
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      );
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await client.connect(transport);
      clients.push(client);
      return client;
    };

    const [a, b] = await Promise.all([mkClient(), mkClient()]);
    const [toolsA, toolsB] = await Promise.all([a.listTools(), b.listTools()]);
    const names = (t: typeof toolsA) => t.tools.map(x => x.name).sort();
    expect(names(toolsA)).toEqual(names(toolsB));
    expect(names(toolsA)).toContain('browser_navigate');
    expect(names(toolsA)).toContain('browser_snapshot');
  });

  it('registers plugin tools (PLUGINS=document-export) with agent-deterring descriptions', async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
    clients.push(client);

    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'browser_print_pdf');
    expect(tool).toBeDefined();
    expect(tools.find(t => t.name === 'browser_export_pptx')).toBeDefined();
    // The description must steer browsing/research agents away from this tool.
    expect(tool!.description).toMatch(/only/i);
    expect(tool!.description).toMatch(/Do NOT use/i);
    expect(tool!.inputSchema).toMatchObject({
      type: 'object',
      required: ['session_id'],
    });
  });

  // Regression: the refactor that introduced ToolDefinition metadata dropped
  // canCreateSession from browser_navigate, so every first navigate failed
  // with "Session not found. Call browser_navigate first to create a session."
  // and no session could ever be created. Navigate MUST be able to create
  // sessions — both with a server-generated id and a caller-supplied one.
  it('browser_navigate creates sessions (generated and caller-supplied ids)', async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
    clients.push(client);

    const text = (r: any) => r.content[0].text as string;
    const sessionOf = (t: string) => t.split('\n')[0].replace('session_id: ', '');

    // 1. No session_id → the server generates one and creates the session.
    const gen: any = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com' } });
    expect(gen.isError).toBeFalsy();
    expect(text(gen)).toMatch(/result: \[lightpanda\] Navigated to/);
    const genId = sessionOf(text(gen));
    expect(genId).toMatch(/^[a-z0-9]+$/);

    const info: any = await client.callTool({ name: 'browser_get_page_info', arguments: { session_id: genId } });
    expect(info.isError).toBeFalsy();
    expect(text(info)).toContain('example.com');

    const closed: any = await client.callTool({ name: 'browser_close', arguments: { session_id: genId } });
    expect(closed.isError).toBeFalsy();

    // 2. Caller-supplied fresh session id (pipeline style) → also creates.
    const fresh: any = await client.callTool({
      name: 'browser_navigate',
      arguments: { session_id: 'reg1', url: 'https://example.com' },
    });
    expect(fresh.isError).toBeFalsy();
    expect(text(fresh)).toContain('session_id: reg1');
    const closed2: any = await client.callTool({ name: 'browser_close', arguments: { session_id: 'reg1' } });
    expect(closed2.isError).toBeFalsy();
  });
});
