import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { parseCliArgs, applyCliArgsToEnv } from './cli-args.js';

// ponytail: stdlib .env loader — no dotenv dependency. Shell env and CLI flags override .env.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

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
