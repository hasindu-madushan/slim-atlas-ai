#!/usr/bin/env bun
import { spawn } from 'child_process';

const server = spawn('bun', ['run', 'src/index.ts'], {
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

setTimeout(() => {
  console.log('Sending initialize request...');
  server.stdin?.write(JSON.stringify(initializeRequest) + '\n');
  
  setTimeout(() => {
    console.log('Sending list tools request...');
    server.stdin?.write(JSON.stringify(listToolsRequest) + '\n');
    
    setTimeout(() => {
      console.log('\n=== Server Response ===');
      console.log(response || '(no response)');
      
      if (response.includes('tools')) {
        console.log('\n✅ MCP protocol works correctly');
      } else {
        console.log('\n⚠️ Unexpected response format');
      }
      
      server.kill();
      process.exit(0);
    }, 1000);
  }, 1000);
}, 1000);