import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOG_FILE = path.join(LOG_DIR, `server_${timestamp}.log`);
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function formatMsg(level: string, tag: string, msg: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level}] [${tag}] ${msg}`;
}

export const log = {
  info(tag: string, msg: string) {
    const line = formatMsg('INFO', tag, msg);
    logStream.write(line + '\n');
  },
  warn(tag: string, msg: string) {
    const line = formatMsg('WARN', tag, msg);
    logStream.write(line + '\n');
    console.error(line);
  },
  error(tag: string, msg: string) {
    const line = formatMsg('ERROR', tag, msg);
    logStream.write(line + '\n');
    console.error(line);
  },
  debug(tag: string, msg: string) {
    const line = formatMsg('DEBUG', tag, msg);
    logStream.write(line + '\n');
  },
  tool(tag: string, toolName: string, args: Record<string, any>, msg: string) {
    const argsStr = JSON.stringify(args);
    const line = formatMsg('TOOL', tag, `${toolName}(${argsStr}) - ${msg}`);
    logStream.write(line + '\n');
  },
  getPath(): string {
    return LOG_FILE;
  },
};
