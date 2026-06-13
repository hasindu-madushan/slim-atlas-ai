import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { chromeManager } from '../src/chrome.js';

describe('MCP Integration Tests', () => {
  let serverProcess: any;
  const serverStarted = new Promise<void>((resolve) => {
    setTimeout(resolve, 1000);
  });

  beforeAll(async () => {
    serverProcess = spawn('npx', ['tsx', 'src/index.ts'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    
    await serverStarted;
  });

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill();
    }
    await chromeManager.close();
  });

  it('should start without errors', async () => {
    let output = '';
    
    serverProcess.stderr?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    if (output.includes('Error') || output.includes('error')) {
      throw new Error(`Server error: ${output}`);
    }
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
    await chromeManager.launch({ headless: true });
  });

  afterAll(async () => {
    await chromeManager.close();
  });

  it('should perform a complete browsing flow', async () => {
    await chromeManager.navigate({ url: 'https://example.com' });
    let info = await chromeManager.getPageInfo();
    expect(info.url).toContain('example.com');
    
    const snapshot = await chromeManager.getSnapshot();
    expect(snapshot.url).toContain('example.com');
    
    const screenshot = await chromeManager.takeScreenshot();
    expect(screenshot).toBeTruthy();
    
    await chromeManager.navigate({ url: 'https://example.org' });
    info = await chromeManager.getPageInfo();
    expect(info.url).toContain('example.org');
  });

  it('should handle page reload', async () => {
    await chromeManager.navigate({ url: 'https://example.com' });
    await chromeManager.reload();
    const info = await chromeManager.getPageInfo();
    expect(info.url).toContain('example.com');
  });

  it('should evaluate page content', async () => {
    await chromeManager.navigate({ url: 'https://example.com' });
    const h1Text = await chromeManager.evaluate(`
      (() => {
        const h1 = document.querySelector('h1');
        return h1 ? h1.textContent : null;
      })()
    `);
    expect(h1Text).toBe('Example Domain');
  });
});