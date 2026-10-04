// document-export: PDF/PPTX conversion tools for generation pipelines.
// Not core browser functionality — enable with PLUGINS=document-export
// (all plugins are disabled by default).

import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer';
import type { ChromeManager } from '../../chrome.js';
import type { PdfOptions } from '../../types.js';
import type { Plugin, ToolDefinition } from '../../plugin-api.js';

// The print/export pipelines pass a full HTML document plus header/footer
// templates — never write those to the debug log.
function redactDocumentArgs(args: Record<string, any>): Record<string, any> {
  return {
    ...args,
    html: args.html ? `<${args.html.length} chars>` : undefined,
    header_template: undefined,
    footer_template: undefined,
  };
}

async function printPdf(manager: ChromeManager, options: PdfOptions): Promise<string> {
  const buffer = await manager.getPage().pdf({ ...options, printBackground: options.printBackground !== false });
  return Buffer.from(buffer).toString('base64');
}

// ponytail: vendored self-contained browser bundle (dom-to-pptx@2.1.1) —
// installing the package would pull a second puppeteer for one static file.
// Upgrade: replace vendor/dom-to-pptx.bundle.js from dist/ of the new version.
async function exportPptx(page: Page, selector: string, withPreviews: boolean): Promise<{ base64: string; slides: number; previews: string[] }> {
  // Slides are authored at final pixel size (convention 1920x1080); a wide
  // viewport keeps vw/vh units and media queries honest during measurement.
  await page.setViewport({ width: 1920, height: 1080 });
  // Previews first: capture the exact layout the pptx will be built from,
  // before the converter touches the DOM.
  const previews: string[] = [];
  if (withPreviews) {
    for (const el of await page.$$(selector)) {
      previews.push(await el.screenshot({ type: 'png', encoding: 'base64' }));
    }
  }
  await page.addScriptTag({ path: fileURLToPath(new URL('./vendor/dom-to-pptx.bundle.js', import.meta.url)) });
  const result = await page.evaluate(async (sel) => {
    await (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
    const targets = Array.from(document.querySelectorAll(sel));
    if (targets.length === 0) throw new Error(`No elements matching slide selector "${sel}"`);
    const lib = (window as unknown as { domToPptx?: { exportToPptx: (t: Element[], o: object) => Promise<Blob> } }).domToPptx;
    if (!lib?.exportToPptx) throw new Error('dom-to-pptx bundle did not load');
    const blob = await lib.exportToPptx(targets, {});
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { base64: btoa(bin), slides: targets.length };
  }, selector);
  return { ...result, previews };
}

const printPdfTool: ToolDefinition = {
  name: 'browser_print_pdf',
  description: 'Print the current page — or a provided HTML document — to a PDF and return it as base64 (can be multi-megabyte). This tool is for document/report generation pipelines ONLY, and the caller MUST close the session with browser_close when done. Do NOT use it for research, reading, extracting, screenshotting, or archiving web content — use browser_snapshot or browser_view_node instead.',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Session ID. Provide a new ID to create a print session; reuse the same ID to print the same page again; close it with browser_close when done.' },
      html: { type: 'string', description: 'Self-contained HTML document to load before printing. Omit to print the current page.' },
      print_background: { type: 'boolean', description: 'Print background graphics', default: true },
      prefer_css_page_size: { type: 'boolean', description: 'Use the CSS @page size over the default paper size', default: false },
      display_header_footer: { type: 'boolean', description: 'Display header/footer templates', default: false },
      header_template: { type: 'string', description: 'HTML template for the page header (Chromium print template; .pageNumber/.totalPages classes available)' },
      footer_template: { type: 'string', description: 'HTML template for the page footer (Chromium print template; .pageNumber/.totalPages classes available)' },
      page_ranges: { type: 'string', description: 'Page ranges to print, e.g. "1" or "2-". Numbering counts all pages of the document.' },
      margin: {
        type: 'object',
        description: 'Page margins, e.g. {"top":"20mm","bottom":"16mm","left":"16mm","right":"16mm"}',
        properties: {
          top: { type: 'string' },
          bottom: { type: 'string' },
          left: { type: 'string' },
          right: { type: 'string' },
        },
      },
    },
    required: ['session_id'],
  },
  canCreateSession: true,
  redactArgsForLog: redactDocumentArgs,
  handler: async (args, ctx) => {
    // PDF needs CDP Page.printToPDF, which lightpanda does not implement —
    // force the real-Chrome fallback pool.
    const manager = await ctx.forceFallback();
    if (args.html) {
      await manager.setContent(args.html);
    }
    const pdfBase64 = await printPdf(manager, {
      printBackground: args.print_background,
      preferCSSPageSize: args.prefer_css_page_size,
      displayHeaderFooter: args.display_header_footer,
      headerTemplate: args.header_template,
      footerTemplate: args.footer_template,
      pageRanges: args.page_ranges,
      margin: args.margin,
    });
    // Base64 goes in a text block (last line): the LangChain mcp-adapter
    // drops non-text content (resource/image blocks) on direct tool.invoke,
    // and the pipeline caller parses the final line as the PDF payload.
    return ctx.textResult(`PDF generated (${Math.round((pdfBase64.length * 3) / 4 / 1024)} KB, ${ctx.browserTag()})\n${pdfBase64}`);
  },
};

const exportPptxTool: ToolDefinition = {
  name: 'browser_export_pptx',
  description: 'Convert the current page — or a provided HTML document — into an editable PowerPoint (.pptx) via dom-to-pptx and return it as base64 (can be multi-megabyte). Slides are the elements matching "selector" (default ".slide"), each laid out at final pixel size (e.g. 1920x1080). This tool is for deck generation pipelines ONLY, and the caller MUST close the session with browser_close when done.',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Session ID. Provide a new ID to create an export session; reuse the same ID to export the same page again; close it with browser_close when done.' },
      html: { type: 'string', description: 'Self-contained HTML document to load before conversion. Omit to convert the current page.' },
      selector: { type: 'string', description: 'CSS selector matching the slide elements', default: '.slide' },
      with_previews: { type: 'boolean', description: 'Also return a base64 PNG screenshot of each slide, captured from the rendered page before conversion (for LLM visual QA)', default: false },
    },
    required: ['session_id'],
  },
  canCreateSession: true,
  redactArgsForLog: redactDocumentArgs,
  handler: async (args, ctx) => {
    // dom-to-pptx measures computed layout (getBoundingClientRect per
    // element), which lightpanda's JS engine cannot produce — it yields
    // structurally-valid but EMPTY slides. Force the real-Chrome fallback.
    const manager = await ctx.forceFallback();
    if (args.html) {
      await manager.setContent(args.html);
    }
    const { base64, slides, previews } = await exportPptx(manager.getPage(), args.selector ?? '.slide', args.with_previews === true);
    const summary = `PPTX generated (${Math.round((base64.length * 3) / 4 / 1024)} KB, ${slides} slides, ${ctx.browserTag()})`;
    // Without previews the pptx base64 stays the final line (pdf-pipeline
    // contract). With previews, slide PNGs come between markers so callers
    // can split base64 payloads deterministically.
    return ctx.textResult(previews.length > 0
      ? `${summary}\n---previews---\n${previews.join('\n')}\n---pptx---\n${base64}`
      : `${summary}\n${base64}`);
  },
};

export const documentExportPlugin: Plugin = {
  name: 'document-export',
  tools: [printPdfTool, exportPptxTool],
};
