import { parseCliArgs, applyCliArgsToEnv } from './cli-args.js';

try {
  const args = parseCliArgs();
  applyCliArgsToEnv(args);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const { PuppeteerMCPServer } = await import('./server.js');
const server = new PuppeteerMCPServer();

server.run().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
