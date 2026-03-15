export interface BrowserOptions {
  headless?: boolean;
  browser?: 'chrome' | 'firefox' | 'webkit';
  args?: string[];
  userDataDir?: string;
  viewport?: {
    width: number;
    height: number;
  };
}

export interface PageInfo {
  id: string;
  url: string;
  title: string;
}

export interface SnapshotResult {
  accessibilityTree: string;
  url: string;
  title: string;
}

export interface NavigateOptions {
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
}

export interface ClickOptions {
  selector: string;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
}

export interface TypeOptions {
  selector: string;
  text: string;
  delay?: number;
}

export interface FillOptions {
  selector: string;
  value: string;
}

export interface EvaluateOptions {
  script: string;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  type?: 'png' | 'jpeg';
  quality?: number;
}

export interface Config {
  headless?: boolean;
  browser?: 'chrome' | 'firefox' | 'webkit';
  args?: string[];
  userDataDir?: string;
  viewport?: {
    width: number;
    height: number;
  };
  allowedHosts?: string[];
  allowedOrigins?: string[];
}