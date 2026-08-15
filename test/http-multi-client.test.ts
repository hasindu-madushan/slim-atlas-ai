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
  let clients: Client[] = [];

  beforeAll(async () => {
    port = await freePort();
    prevPort = process.env.MCP_PORT;
    prevHost = process.env.MCP_HOST;
    prevToken = process.env.MCP_AUTH_TOKEN;
    process.env.MCP_TRANSPORT = 'http';
    process.env.MCP_PORT = String(port);
    process.env.MCP_HOST = '127.0.0.1';
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
});
