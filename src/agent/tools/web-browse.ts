import { execFile } from 'child_process';
import { resolve } from 'path';
import { AgentTool, ToolResult } from './types';

const SCRAPLING_BRIDGE = resolve(__dirname, '../../scripts/scrapling_bridge.py');
const SCRAPLING_TIMEOUT_MS = 60000;

/**
 * Execute the Scrapling Python bridge script with the given command payload.
 * Sends JSON on stdin, receives JSON on stdout.
 */
function runScraplingBridge(cmd: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'python3',
      [SCRAPLING_BRIDGE],
      { timeout: SCRAPLING_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          const msg = stderr || error.message;
          return reject(new Error(`scrapling bridge failed: ${msg}`));
        }
        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch {
          reject(new Error(`scrapling bridge returned invalid JSON: ${stdout.slice(0, 500)}`));
        }
      },
    );
    child.stdin?.write(JSON.stringify(cmd));
    child.stdin?.end();
  });
}

export const webBrowseTool: AgentTool = {
  name: 'web_browse',
  description: `Browse web pages using a stealth browser (Scrapling/Camoufox) that avoids bot detection. Supports navigating to URLs, extracting page content, clicking elements, filling forms, and executing JavaScript. Each call opens a fresh page. Use multiple calls for multi-step workflows.`,
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

    try {
      const result = await runScraplingBridge({
        url,
        action,
        selector,
        value,
        javascript,
        wait_for: waitFor,
      });
      return {
        content: result.content,
        isError: result.isError,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `web_browse error: ${msg}`, isError: true };
    }
  },
};
