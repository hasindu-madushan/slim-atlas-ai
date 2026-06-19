import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page, BrowserContext } from 'puppeteer';
import type { NavigateOptions, PageInfo, SnapshotResult, ScreenshotOptions } from './types.js';
import { BrowserTools, type BrowserToolsState, type ViewNodeResult } from './browser-tools.js';
import { getAntiDetectionArgs, applyStealthToPage, isStealthEnabled } from './stealth.js';

const DEFAULT_WAIT_UNTIL = (process.env.NAVIGATE_WAIT_UNTIL || 'domcontentloaded') as NavigateOptions['waitUntil'];
const DEFAULT_NAVIGATE_TIMEOUT = parseInt(process.env.NAVIGATE_TIMEOUT || '30000', 10);

puppeteer.use(StealthPlugin());

const CHROME_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-translate',
  '--metrics-recording-only',
  '--mute-audio',
  ...getAntiDetectionArgs(),
];

export class ChromeManager {
  private browser: Browser | null = null;
  private ownedBrowser = false;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private tools: BrowserTools | null = null;
  private pendingState: BrowserToolsState | null = null;
  private snapshotOptions: { flattenSingleChild: boolean; textTrimLength: number } = {
    flattenSingleChild: process.env.SNAPSHOT_FLATTEN?.toLowerCase() !== 'false',
    textTrimLength: parseInt(process.env.SNAPSHOT_TEXT_TRIM_LENGTH || '200', 10),
  };

  constructor(options?: { browser?: Browser; context?: BrowserContext; page?: Page }) {
    if (options?.browser) this.browser = options.browser;
    if (options?.context) this.context = options.context;
    if (options?.page) this.page = options.page;
  }

  setSnapshotOptions(options: { flattenSingleChild?: boolean; textTrimLength?: number }): void {
    this.snapshotOptions = { ...this.snapshotOptions, ...options };
    if (this.tools) {
      // Snapshot options are captured at tools creation time; recreate to apply changes.
      this.tools = null;
    }
  }

  async launch(): Promise<void> {
    if (this.browser && this.browser.connected) return;
    await this.close();

    this.browser = await puppeteer.launch({ headless: true as any, args: CHROME_LAUNCH_ARGS, protocolTimeout: 30000 });
    this.ownedBrowser = true;
    this.context = await this.browser.createBrowserContext();
    this.page = await this.context.newPage();
    await applyStealthToPage(this.page);
  }

  async close(): Promise<void> {
    this.tools = null;
    this.pendingState = null;
    if (this.page) { try { await this.page.close(); } catch (e) {} this.page = null; }
    if (this.context) { try { await this.context.close(); } catch (e) {} this.context = null; }
    if (this.ownedBrowser && this.browser) {
      try { await this.browser.close(); } catch (e) {}
      this.browser = null;
      this.ownedBrowser = false;
    }
  }

  isConnected(): boolean {
    return this.page !== null && !this.page.isClosed();
  }

  getPage(): Page {
    if (!this.page) throw new Error('Chrome browser not launched. Call launch() first.');
    return this.page;
  }

  private getTools(): BrowserTools {
    if (!this.tools) {
      this.tools = new BrowserTools(this.getPage(), this.snapshotOptions);
      if (this.pendingState) {
        this.tools.setState(this.pendingState);
        this.pendingState = null;
      }
    }
    return this.tools;
  }

  getState(): BrowserToolsState {
    return this.getTools().getState();
  }

  setState(state: BrowserToolsState): void {
    if (this.tools) {
      this.tools.setState(state);
    } else {
      this.pendingState = state;
    }
  }

  // Browser lifecycle operations (not part of common BrowserTools)
  async navigate(options: NavigateOptions): Promise<void> {
    const page = this.getPage();
    await page.goto(options.url, { waitUntil: options.waitUntil || DEFAULT_WAIT_UNTIL, timeout: DEFAULT_NAVIGATE_TIMEOUT });
  }

  // Common tool operations delegated to BrowserTools
  async getPageInfo(): Promise<PageInfo> {
    return this.getTools().getPageInfo();
  }

  async getSnapshot(showUrls?: boolean): Promise<SnapshotResult> {
    return this.getTools().getSnapshot(showUrls);
  }

  async viewNode(nodeId: number): Promise<ViewNodeResult> {
    return this.getTools().viewNode(nodeId);
  }

  async getSelectorByNodeId(nodeId: number): Promise<string | null> {
    return this.getTools().getSelectorByNodeId(nodeId);
  }

  async click(selector: string): Promise<void> {
    await this.getTools().click(selector);
  }

  async type(selector: string, text: string, options: { delay?: number } = {}): Promise<void> {
    await this.getTools().type(selector, text, options);
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.getTools().fill(selector, value);
  }

  async evaluate(script: string): Promise<any> {
    return this.getTools().evaluate(script);
  }

  async takeScreenshot(options: ScreenshotOptions = {}): Promise<string> {
    return this.getTools().takeScreenshot(options);
  }

  async getHtml(): Promise<string> {
    return this.getTools().getHtml();
  }

  async goBack(): Promise<void> {
    await this.getTools().goBack();
  }

  async goForward(): Promise<void> {
    await this.getTools().goForward();
  }

  async reload(): Promise<void> {
    await this.getTools().reload();
  }
}

export const chromeManager = new ChromeManager();
