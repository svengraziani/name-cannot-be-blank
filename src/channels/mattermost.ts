import { ChannelAdapter, IncomingMessage } from './base';

export interface MattermostConfig {
  token: string;
  webhookUrl?: string;
}

/**
 * Mattermost channel adapter using Slash Commands + Incoming Webhooks.
 *
 * Flow:
 * 1. User types /ask in Mattermost → Mattermost POSTs slash command to our webhook
 * 2. We verify the token, respond with "Thinking..." immediately
 * 3. Emit 'message' event → agent loop processes
 * 4. sendMessage() POSTs result back via response_url or webhookUrl
 */
export class MattermostAdapter extends ChannelAdapter {
  private readonly conf: MattermostConfig;
  /** Maps channel_id → response_url for async responses */
  private responseUrls = new Map<string, string>();

  constructor(channelId: string, conf: MattermostConfig) {
    super(channelId, 'mattermost');
    this.conf = conf;
  }

  async connect(): Promise<void> {
    if (!this.conf.token) {
      this.setStatus('error', 'No verification token configured');
      return;
    }
    console.log(`[mattermost:${this.channelId}] Ready (webhook-based, no persistent connection)`);
    this.setStatus('connected');
  }

  async disconnect(): Promise<void> {
    this.responseUrls.clear();
    this.setStatus('disconnected');
  }

  async sendMessage(externalChatId: string, text: string): Promise<void> {
    const url = this.responseUrls.get(externalChatId) || this.conf.webhookUrl;
    if (!url) {
      console.error(`[mattermost:${this.channelId}] No response_url or webhookUrl for ${externalChatId}`);
      return;
    }

    const payload = { text, response_type: 'in_channel' };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[mattermost:${this.channelId}] Failed to send message: ${res.status} ${body}`);
    }
  }

  /**
   * Handle an incoming Mattermost slash command request.
   * Called by the webhook route in server.ts.
   *
   * Mattermost sends application/x-www-form-urlencoded with fields:
   *   token, team_id, team_domain, channel_id, channel_name,
   *   user_id, user_name, command, text, response_url
   */
  handleSlashCommand(
    req: { body: Record<string, string> },
    res: { json: (data: unknown) => void; status: (code: number) => { json: (data: unknown) => void } },
  ): void {
    const body = req.body;
    const token = body.token ?? '';
    const channel_id = body.channel_id ?? '';
    const user_id = body.user_id ?? '';
    const user_name = body.user_name ?? '';
    const text = body.text ?? '';
    const response_url = body.response_url ?? '';
    const channel_name = body.channel_name ?? '';

    // Verify token
    if (token !== this.conf.token) {
      res.status(401).json({ text: 'Invalid token' });
      return;
    }

    // Reject empty messages (e.g. user typed just the slash command with no text)
    if (!text.trim()) {
      res.json({ text: 'Please provide a message, e.g. `/ask hello`' });
      return;
    }

    // Store response_url for async reply
    if (response_url) {
      this.responseUrls.set(channel_id, response_url);
    }

    // Respond immediately so Mattermost doesn't time out
    res.json({ text: 'Thinking...' });

    // Emit message for agent processing
    const incoming: IncomingMessage = {
      channelId: this.channelId,
      channelType: 'mattermost',
      externalChatId: channel_id,
      sender: user_name || user_id,
      text,
      chatTitle: channel_name || undefined,
    };

    this.emit('message', incoming);
  }
}
