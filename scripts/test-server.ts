#!/usr/bin/env bun
import { spawn } from 'child_process';

const serverProcess = spawn('bun', ['run', 'src/index.ts'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let output = '';
let errorOutput = '';

serverProcess.stdout?.on('data', (data: Buffer) => {
  output += data.toString();
});

serverProcess.stderr?.on('data', (data: Buffer) => {
  errorOutput += data.toString();
});

setTimeout(() => {
  console.log('=== Server stdout ===');
  console.log(output || '(empty)');
  console.log('=== Server stderr ===');
  console.log(errorOutput || '(empty)');
  
  if (errorOutput.includes('Error')) {
    console.log('\n❌ Server encountered an error');
    process.exit(1);
  }
  
  console.log('\n✅ Server started successfully');
  serverProcess.kill();
  process.exit(0);
}, 3000);