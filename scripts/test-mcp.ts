#!/usr/bin/env node
import { spawn } from 'child_process';

const server = spawn('npx', ['tsx', 'src/index.ts'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let response = '';

server.stdout?.on('data', (data: Buffer) => {
  response += data.toString();
});

const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: {
      name: 'test-client',
      version: '1.0.0',
    },
  },
};

const listToolsRequest = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
};

const navigateRequest = {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'browser_navigate',
    arguments: {
      url: 'https://example.com',
    },
  },
};

const snapshotRequest = {
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: {
    name: 'browser_snapshot',
    arguments: {},
  },
};

function sendRequest(req: any) {
  server.stdin?.write(JSON.stringify(req) + '\n');
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractSessionId(text: string): string | null {
  const match = text.match(/session_id:\s*(\S+)/);
  return match?.[1] ?? null;
}

async function run() {
  console.log('1. Sending initialize...');
  sendRequest(initializeRequest);
  await wait(1000);

  console.log('2. Listing tools...');
  response = '';
  sendRequest(listToolsRequest);
  await wait(1000);

  console.log('\n=== Tool List ===');
  if (response.includes('tools')) {
    console.log('✅ MCP protocol works, tools listed');
  } else {
    console.log('⚠️ Unexpected response:', response);
  }

  console.log('\n3. Calling browser_navigate (no session_id, should create new session)...');
  response = '';
  sendRequest(navigateRequest);
  await wait(3000);

  console.log('\n=== Navigate Response ===');
  console.log(response || '(no response)');

  const sessionId = extractSessionId(response);
  if (sessionId) {
    console.log(`\n✅ Session created: ${sessionId}`);
  } else {
    console.log('\n⚠️ No session_id found in navigate response');
    server.kill();
    process.exit(1);
  }

  console.log(`\n4. Calling browser_snapshot with session_id: ${sessionId}...`);
  response = '';
  snapshotRequest.params.arguments.session_id = sessionId;
  sendRequest(snapshotRequest);
  await wait(2000);

  console.log('\n=== Snapshot Response ===');
  const snapshotHasSession = response.includes(`session_id: ${sessionId}`);
  if (snapshotHasSession) {
    console.log('✅ Snapshot returned with correct session_id');
  } else {
    console.log('⚠️ Snapshot response:', response.slice(0, 500));
  }

  console.log('\n5. Calling browser_snapshot WITHOUT session_id (should error)...');
  response = '';
  const badSnapshotRequest = {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'browser_snapshot',
      arguments: {},
    },
  };
  sendRequest(badSnapshotRequest);
  await wait(1000);

  console.log('\n=== Bad Snapshot Response ===');
  const hasError = response.includes('isError') || response.includes('ERROR');
  if (hasError) {
    console.log('✅ Correctly rejected missing session_id');
  } else {
    console.log('⚠️ Expected error for missing session_id:', response.slice(0, 300));
  }

  console.log('\n6. Calling browser_close...');
  response = '';
  const closeRequest = {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'browser_close',
      arguments: { session_id: sessionId },
    },
  };
  sendRequest(closeRequest);
  await wait(1000);

  console.log('\n=== Close Response ===');
  console.log(response.includes('closed') ? '✅ Session closed' : `⚠️ ${response.slice(0, 200)}`);

  server.kill();
  process.exit(0);
}

setTimeout(() => {
  run().catch((err) => {
    console.error('Test failed:', err);
    server.kill();
    process.exit(1);
  });
}, 500);