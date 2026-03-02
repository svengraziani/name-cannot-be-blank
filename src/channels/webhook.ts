import { timingSafeEqual } from 'crypto';
import { ChannelAdapter, IncomingMessage } from './base';

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Run a dummy compare to avoid leaking length via timing
    timingSafeEqual(Buffer.from(a), Buffer.from(a));
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export interface WebhookConfig {
  /** Optional secret token for verifying inbound requests */
  secret?: string;
  /** URL to POST agent responses to (outbound) */
  callbackUrl?: string;
}

/**
 * Generic Webhook channel adapter (Inbound + Outbound).
 *
 * Inbound flow:
 *   External app POSTs to /webhook/incoming/:channelId with JSON body:
 *     { "sender": "user-id", "text": "message", "chatId": "optional-chat-id" }
 *   Optional Authorization header: Bearer <secret>
 *
 * Outbound flow:
 *   Agent response is POSTed to the configured callbackUrl as JSON:
 *     { "channelId": "...", "chatId": "...", "text": "...", "timestamp": "..." }
 *   If no callbackUrl is configured, the response is returned synchronously
 *   in the inbound webhook response.
 */
export class WebhookAdapter extends ChannelAdapter {
  private readonly conf: WebhookConfig;
  /** Maps chatId → pending response resolve function (for sync mode) */
  private pendingResponses = new Map<string, (text: string) => void>();

  constructor(channelId: string, conf: WebhookConfig) {
    super(channelId, 'webhook');
    this.conf = conf;
  }

  async connect(): Promise<void> {
    console.log(`[webhook:${this.channelId}] Ready (webhook-based, no persistent connection)`);
    if (this.conf.callbackUrl) {
      console.log(`[webhook:${this.channelId}] Callback URL: ${this.conf.callbackUrl}`);
    } else {
      console.log(`[webhook:${this.channelId}] Sync mode (no callbackUrl, responses returned inline)`);
    }
    this.setStatus('connected');
  }

  async disconnect(): Promise<void> {
    this.pendingResponses.clear();
    this.setStatus('disconnected');
  }

  async sendMessage(externalChatId: string, text: string): Promise<void> {
    // If a callbackUrl is configured, POST the response there
    if (this.conf.callbackUrl) {
      const payload = {
        channelId: this.channelId,
        chatId: externalChatId,
        text,
        timestamp: new Date().toISOString(),
      };

      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.conf.secret) {
          headers['Authorization'] = `Bearer ${this.conf.secret}`;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30_000);

        let res: Response;
        try {
          res = await fetch(this.conf.callbackUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          console.error(`[webhook:${this.channelId}] Callback failed: ${res.status} ${body}`);
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          console.error(`[webhook:${this.channelId}] Callback timed out after 30s`);
        } else {
          console.error(`[webhook:${this.channelId}] Callback error:`, err);
        }
      }
    } else {
      // Sync mode: resolve the pending response promise
      const resolve = this.pendingResponses.get(externalChatId);
      if (resolve) {
        resolve(text);
        this.pendingResponses.delete(externalChatId);
      }
    }
  }

  /**
   * Handle an incoming webhook request.
   * Called by the webhook route in server.ts.
   *
   * Expects JSON body:
   *   { "sender": "user-id", "text": "hello", "chatId": "optional" }
   */
  handleIncomingWebhook(
    req: { body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> },
    res: { json: (data: unknown) => void; status: (code: number) => { json: (data: unknown) => void } },
  ): void {
    // Verify secret if configured
    if (this.conf.secret) {
      const authHeader = (req.headers['authorization'] || req.headers['Authorization'] || '') as string;
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (!safeCompare(token, this.conf.secret)) {
        res.status(401).json({ error: 'Invalid or missing authorization token' });
        return;
      }
    }

    const body = req.body;
    const sender = String(body.sender || 'anonymous');
    const text = String(body.text || '');
    const chatId = String(body.chatId || sender);

    if (!text.trim()) {
      res.status(400).json({ error: 'text field is required and must not be empty' });
      return;
    }

    const incoming: IncomingMessage = {
      channelId: this.channelId,
      channelType: 'webhook',
      externalChatId: chatId,
      sender,
      text,
    };

    if (this.conf.callbackUrl) {
      // Async mode: acknowledge immediately, response goes to callbackUrl
      res.json({ status: 'accepted', channelId: this.channelId, chatId });
      this.emit('message', incoming);
    } else {
      // Sync mode: reject concurrent requests for the same chatId
      if (this.pendingResponses.has(chatId)) {
        res.status(409).json({ error: 'A sync request for this chatId is already in progress' });
        return;
      }

      // Sync mode: wait for agent response and return it inline
      const timeout = 120_000; // 2 minutes
      const timer = setTimeout(() => {
        this.pendingResponses.delete(chatId);
        res.status(504).json({ error: 'Agent response timed out' });
      }, timeout);

      this.pendingResponses.set(chatId, (responseText: string) => {
        clearTimeout(timer);
        res.json({ status: 'ok', channelId: this.channelId, chatId, response: responseText });
      });

      this.emit('message', incoming);
    }
  }

  getStatusInfo(): Record<string, unknown> {
    return {
      callbackUrl: this.conf.callbackUrl || null,
      mode: this.conf.callbackUrl ? 'async' : 'sync',
      hasSecret: !!this.conf.secret,
    };
  }
}
