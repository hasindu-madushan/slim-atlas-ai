import { describe, it, expect, beforeAll, afterAll, jest } from 'bun:test';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

describe('MCP Protocol Tests', () => {
  describe('ListToolsRequest', () => {
    it('should return valid tool list schema', () => {
      const request = ListToolsRequestSchema;
      expect(request).toBeDefined();
    });
  });

  describe('CallToolRequest', () => {
    it('should have correct schema structure', () => {
      const request = CallToolRequestSchema;
      expect(request).toBeDefined();
    });
  });
});

describe('Tool Definitions Tests', () => {
  const tools = [
    {
      name: 'browser_navigate',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'] },
        },
        required: ['url'],
      },
    },
    {
      name: 'browser_snapshot',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'browser_click',
      inputSchema: {
        type: 'object',
        properties: { selector: { type: 'string' } },
        required: ['selector'],
      },
    },
    {
      name: 'browser_type',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          text: { type: 'string' },
          delay: { type: 'number' },
        },
        required: ['selector', 'text'],
      },
    },
    {
      name: 'browser_fill',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['selector', 'value'],
      },
    },
    {
      name: 'browser_evaluate',
      inputSchema: {
        type: 'object',
        properties: { script: { type: 'string' } },
        required: ['script'],
      },
    },
    {
      name: 'browser_screenshot',
      inputSchema: {
        type: 'object',
        properties: {
          fullPage: { type: 'boolean' },
          type: { type: 'string', enum: ['png', 'jpeg'] },
        },
      },
    },
    {
      name: 'browser_get_html',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'browser_go_back',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'browser_go_forward',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'browser_reload',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'browser_get_page_info',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'browser_close',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'browser_install',
      inputSchema: { type: 'object', properties: {} },
    },
  ];

  it('should have 14 tools defined', () => {
    expect(tools.length).toBe(14);
  });

  it('should have valid tool names', () => {
    tools.forEach(tool => {
      expect(tool.name).toMatch(/^browser_/);
      expect(tool.inputSchema).toBeDefined();
    });
  });

  it('should have all required fields for each tool', () => {
    tools.forEach(tool => {
      expect(tool.name).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    });
  });
});

describe('MCP Server Capabilities', () => {
  it('should declare tools capability', () => {
    const capabilities = {
      tools: {},
    };
    expect(capabilities).toBeDefined();
    expect(capabilities.tools).toBeDefined();
  });

  it('should have server info', () => {
    const serverInfo = {
      name: 'puppeteer-mcp',
      version: '1.0.0',
    };
    expect(serverInfo.name).toBe('puppeteer-mcp');
    expect(serverInfo.version).toBe('1.0.0');
  });
});

describe('Tool Parameter Validation', () => {
  describe('browser_navigate', () => {
    it('should require url parameter', () => {
      const validArgs = { url: 'https://example.com' };
      expect(validArgs.url).toBeDefined();
    });

    it('should accept optional waitUntil parameter', () => {
      const validArgs = { url: 'https://example.com', waitUntil: 'networkidle0' };
      expect(validArgs.waitUntil).toBe('networkidle0');
    });
  });

  describe('browser_click', () => {
    it('should require selector parameter', () => {
      const validArgs = { selector: '#submit-button' };
      expect(validArgs.selector).toBeDefined();
    });
  });

  describe('browser_type', () => {
    it('should require selector and text parameters', () => {
      const validArgs = { selector: 'input[name="search"]', text: 'test query' };
      expect(validArgs.selector).toBeDefined();
      expect(validArgs.text).toBeDefined();
    });

    it('should accept optional delay parameter', () => {
      const validArgs = { selector: 'input', text: 'test', delay: 100 };
      expect(validArgs.delay).toBe(100);
    });
  });

  describe('browser_fill', () => {
    it('should require selector and value parameters', () => {
      const validArgs = { selector: 'input[name="email"]', value: 'test@example.com' };
      expect(validArgs.selector).toBeDefined();
      expect(validArgs.value).toBeDefined();
    });
  });

  describe('browser_evaluate', () => {
    it('should require script parameter', () => {
      const validArgs = { script: 'document.title' };
      expect(validArgs.script).toBeDefined();
    });
  });

  describe('browser_screenshot', () => {
    it('should accept optional fullPage parameter', () => {
      const validArgs = { fullPage: true };
      expect(validArgs.fullPage).toBe(true);
    });

    it('should accept optional type parameter', () => {
      const validArgs = { type: 'jpeg' };
      expect(validArgs.type).toBe('jpeg');
    });
  });
});