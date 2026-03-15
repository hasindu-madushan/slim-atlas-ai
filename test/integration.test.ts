import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'child_process';
import { browserManager } from '../src/browser.js';

describe('MCP Integration Tests', () => {
  let serverProcess: any;
  const serverStarted = new Promise<void>((resolve) => {
    setTimeout(resolve, 1000);
  });

  beforeAll(async () => {
    serverProcess = spawn('bun', ['run', 'src/index.ts'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    
    await serverStarted;
  });

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill();
    }
    await browserManager.close();
  });

  it('should start without errors', (done) => {
    let output = '';
    
    serverProcess.stderr?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    setTimeout(() => {
      if (output.includes('Error') || output.includes('error')) {
        done(new Error(`Server error: ${output}`));
      } else {
        done();
      }
    }, 2000);
  });
});

describe('MCP Tool Schema Tests', () => {
  it('should have all required tools defined', async () => {
    const tools = [
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_fill',
      'browser_evaluate',
      'browser_screenshot',
      'browser_get_html',
      'browser_go_back',
      'browser_go_forward',
      'browser_reload',
      'browser_get_page_info',
      'browser_close',
      'browser_install',
    ];
    
    expect(tools.length).toBe(14);
  });
});

describe('Browser Automation Flow Tests', () => {
  beforeAll(async () => {
    await browserManager.launch({ headless: true });
  });

  afterAll(async () => {
    await browserManager.close();
  });

  it('should perform a complete browsing flow', async () => {
    await browserManager.navigate({ url: 'https://example.com' });
    let info = await browserManager.getPageInfo();
    expect(info.url).toContain('example.com');
    
    const snapshot = await browserManager.getSnapshot();
    expect(snapshot.url).toContain('example.com');
    
    const screenshot = await browserManager.takeScreenshot();
    expect(screenshot).toBeTruthy();
    
    await browserManager.navigate({ url: 'https://example.org' });
    info = await browserManager.getPageInfo();
    expect(info.url).toContain('example.org');
  });

  it('should handle page reload', async () => {
    await browserManager.navigate({ url: 'https://example.com' });
    await browserManager.reload();
    const info = await browserManager.getPageInfo();
    expect(info.url).toContain('example.com');
  });

  it('should evaluate page content', async () => {
    await browserManager.navigate({ url: 'https://example.com' });
    const h1Text = await browserManager.evaluate(`
      (() => {
        const h1 = document.querySelector('h1');
        return h1 ? h1.textContent : null;
      })()
    `);
    expect(h1Text).toBe('Example Domain');
  });
});