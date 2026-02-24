import { AgentTool, ToolResult } from './types';

// Lazy-loaded Playwright browser singleton
let browserPromise: Promise<import('playwright').Browser> | null = null;
let browserInstance: import('playwright').Browser | null = null;

async function getBrowser(): Promise<import('playwright').Browser> {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      browserInstance = browser;
      browser.on('disconnected', () => {
        browserInstance = null;
        browserPromise = null;
      });
      console.log('[tools:web_browse] Browser launched');
      return browser;
    })();
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
    browserPromise = null;
  }
}

export const webBrowseTool: AgentTool = {
  name: 'web_browse',
  description: `Browse web pages using a real browser (Playwright/Chromium). Supports navigating to URLs, extracting page content, clicking elements, filling forms, and executing JavaScript. Each call opens a fresh page. Use multiple calls for multi-step workflows.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: 'The URL to navigate to',
      },
      action: {
        type: 'string',
        enum: ['get_content', 'click', 'fill', 'evaluate'],
        description: 'Action to perform after navigation. Default: get_content',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for click/fill actions',
      },
      value: {
        type: 'string',
        description: 'Value for fill action',
      },
      javascript: {
        type: 'string',
        description: 'JavaScript code to evaluate on the page (for evaluate action)',
      },
      wait_for: {
        type: 'string',
        description: 'CSS selector to wait for before performing action',
      },
    },
    required: ['url'],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const url = input.url as string;
    const action = (input.action as string) || 'get_content';
    const selector = input.selector as string | undefined;
    const value = input.value as string | undefined;
    const javascript = input.javascript as string | undefined;
    const waitFor = input.wait_for as string | undefined;

    let page: import('playwright').Page | null = null;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
      page.setDefaultTimeout(30000);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      if (waitFor) {
        await page.waitForSelector(waitFor, { timeout: 10000 });
      }

      switch (action) {
        case 'get_content': {
          const title = await page.title();
          const text = await page.evaluate(`
            (() => {
              document.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
              return document.body?.innerText || '';
            })()
          `);
          const textStr = String(text);
          const truncated = textStr.length > 15000 ? textStr.slice(0, 15000) + '\n...(truncated)' : textStr;
          return { content: `Page: ${title}\nURL: ${page.url()}\n\n${truncated}` };
        }

        case 'click': {
          if (!selector) return { content: 'Error: selector is required for click action', isError: true };
          await page.click(selector);
          // Wait for navigation or content change
          await page.waitForTimeout(1500);
          const title = await page.title();
          const text = await page.evaluate(`
            (() => {
              document.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
              return document.body?.innerText || '';
            })()
          `);
          const textStr = String(text);
          const truncated = textStr.length > 10000 ? textStr.slice(0, 10000) + '\n...(truncated)' : textStr;
          return { content: `Clicked "${selector}"\nPage: ${title}\nURL: ${page.url()}\n\n${truncated}` };
        }

        case 'fill': {
          if (!selector) return { content: 'Error: selector is required for fill action', isError: true };
          if (value === undefined) return { content: 'Error: value is required for fill action', isError: true };
          await page.fill(selector, value);
          return { content: `Filled "${selector}" with value "${value}"` };
        }

        case 'evaluate': {
          if (!javascript) return { content: 'Error: javascript is required for evaluate action', isError: true };
          const result = await page.evaluate(javascript);
          const resultStr = JSON.stringify(result, null, 2);
          const truncated = resultStr.length > 10000 ? resultStr.slice(0, 10000) + '\n...(truncated)' : resultStr;
          return { content: `JavaScript result:\n${truncated}` };
        }

        default:
          return { content: `Unknown action: ${action}`, isError: true };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `web_browse error: ${msg}`, isError: true };
    } finally {
      if (page) {
        try { await page.close(); } catch {}
      }
    }
  },
};
