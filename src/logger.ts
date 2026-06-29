import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOG_FILE = path.join(LOG_DIR, `server_${timestamp}.log`);
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

// Explicit config wins; otherwise mirror to stdout only when stdout isn't being
// used by the MCP protocol (i.e. HTTP transport). In stdio mode stray writes to
// stdout would corrupt the JSON-RPC stream.
function resolveUseStdout(): boolean {
  const v = process.env.LOG_TO_STDOUT;
  if (v !== undefined && v !== '') return v === 'true' || v === '1';
  return process.env.MCP_TRANSPORT === 'http';
}
const useStdout = resolveUseStdout();

function formatMsg(level: string, tag: string, msg: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level}] [${tag}] ${msg}`;
}

function emit(line: string): void {
  logStream.write(line + '\n');
  if (useStdout) process.stdout.write(line + '\n');
}

export const log = {
  info(tag: string, msg: string) {
    emit(formatMsg('INFO', tag, msg));
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
    emit(formatMsg('DEBUG', tag, msg));
  },
  tool(tag: string, toolName: string, args: Record<string, any>, msg: string) {
    const argsStr = JSON.stringify(args);
    emit(formatMsg('TOOL', tag, `${toolName}(${argsStr}) - ${msg}`));
  },
  getPath(): string {
    return LOG_FILE;
  },
};
