import { PuppeteerMCPServer } from './server.js';

const server = new PuppeteerMCPServer();

server.run().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});