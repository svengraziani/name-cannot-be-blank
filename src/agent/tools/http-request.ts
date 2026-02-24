import { AgentTool, ToolResult } from './types';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_LENGTH = 20000;

export const httpRequestTool: AgentTool = {
  name: 'http_request',
  description: `Make HTTP requests to APIs and web services. Supports GET, POST, PUT, PATCH, DELETE methods with custom headers and JSON/text bodies. Returns status code, headers, and response body.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: 'The URL to send the request to',
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        description: 'HTTP method (default: GET)',
      },
      headers: {
        type: 'object',
        description: 'Request headers as key-value pairs',
        additionalProperties: { type: 'string' },
      },
      body: {
        type: 'string',
        description: 'Request body (for POST/PUT/PATCH). If Content-Type is application/json, this should be a JSON string.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Request timeout in milliseconds (default: 30000)',
      },
    },
    required: ['url'],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const url = input.url as string;
    const method = ((input.method as string) || 'GET').toUpperCase();
    const headers = (input.headers as Record<string, string>) || {};
    const body = input.body as string | undefined;
    const timeoutMs = (input.timeout_ms as number) || DEFAULT_TIMEOUT_MS;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
        fetchOptions.body = body;
        // Auto-set Content-Type if not specified and body looks like JSON
        if (!headers['Content-Type'] && !headers['content-type']) {
          try {
            JSON.parse(body);
            (fetchOptions.headers as Record<string, string>)['Content-Type'] = 'application/json';
          } catch {
            // Not JSON, leave Content-Type unset
          }
        }
      }

      const response = await fetch(url, fetchOptions);
      clearTimeout(timer);

      const statusLine = `${response.status} ${response.statusText}`;

      // Collect response headers
      const respHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => { respHeaders[k] = v; });

      const contentType = response.headers.get('content-type') || '';
      let responseBody: string;

      if (contentType.includes('application/json')) {
        try {
          const json = await response.json();
          responseBody = JSON.stringify(json, null, 2);
        } catch {
          responseBody = await response.text();
        }
      } else if (contentType.includes('text/') || contentType.includes('xml') || contentType.includes('javascript')) {
        responseBody = await response.text();
      } else {
        // Binary or unknown - just report size
        const buffer = await response.arrayBuffer();
        responseBody = `[Binary response: ${buffer.byteLength} bytes, Content-Type: ${contentType}]`;
      }

      if (responseBody.length > MAX_RESPONSE_LENGTH) {
        responseBody = responseBody.slice(0, MAX_RESPONSE_LENGTH) + '\n...(truncated)';
      }

      const parts = [
        `HTTP ${statusLine}`,
        `Response headers: ${JSON.stringify(respHeaders, null, 2)}`,
        `\nBody:\n${responseBody}`,
      ];

      return {
        content: parts.join('\n'),
        isError: response.status >= 400,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort')) {
        return { content: `Request timed out after ${timeoutMs}ms`, isError: true };
      }
      return { content: `HTTP request error: ${msg}`, isError: true };
    }
  },
};
