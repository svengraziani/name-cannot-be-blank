import { App, LogLevel } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { ChannelAdapter, IncomingMessage } from './base';
import { respondToApproval } from '../agent/hitl';

export interface SlackConfig {
  botToken: string;
  appToken: string;
  signingSecret: string;
  /** Allowed channel IDs (empty = all channels) */
  allowedChannels: string[];
}

export class SlackAdapter extends ChannelAdapter {
  private app?: App;
  private webClient?: WebClient;
  private readonly conf: SlackConfig;

  constructor(channelId: string, conf: SlackConfig) {
    super(channelId, 'slack');
    this.conf = conf;
  }

  async connect(): Promise<void> {
    if (!this.conf.botToken || !this.conf.appToken) {
      this.setStatus('error', 'Bot token and app token are required');
      return;
    }

    this.setStatus('connecting');

    try {
      this.app = new App({
        token: this.conf.botToken,
        appToken: this.conf.appToken,
        signingSecret: this.conf.signingSecret || undefined,
        socketMode: true,
        logLevel: LogLevel.WARN,
      });

      this.webClient = new WebClient(this.conf.botToken);

      // Listen for messages
      this.app.message(async ({ message }) => {
        // Only handle regular user messages
        if (message.subtype) return;
        if (!('text' in message) || !message.text) return;
        if ('bot_id' in message && message.bot_id) return;

        const channelId = message.channel;
        const userId = 'user' in message ? message.user : undefined;

        // Filter by allowed channels
        if (this.conf.allowedChannels.length > 0 && !this.conf.allowedChannels.includes(channelId)) {
          return;
        }

        // Resolve user name
        let sender = userId || 'unknown';
        if (userId && this.webClient) {
          try {
            const userInfo = await this.webClient.users.info({ user: userId });
            sender = userInfo.user?.real_name || userInfo.user?.name || userId;
          } catch {
            // Fall back to user ID
          }
        }

        // Get channel name
        let chatTitle: string | undefined;
        if (this.webClient) {
          try {
            const channelInfo = await this.webClient.conversations.info({ channel: channelId });
            chatTitle = (channelInfo.channel as any)?.name || undefined;
          } catch {
            // ignore
          }
        }

        const incoming: IncomingMessage = {
          channelId: this.channelId,
          channelType: 'slack',
          externalChatId: channelId,
          sender,
          text: message.text,
          chatTitle,
        };

        this.emit('message', incoming);
      });

      // Handle button actions (approve/reject)
      this.app.action(/^(approve|reject):/, async ({ action, ack, respond, body }) => {
        await ack();

        if (action.type !== 'button') return;
        const actionId = 'action_id' in action ? action.action_id : '';
        const [actionType, approvalId] = actionId.split(':');
        if (!approvalId) return;

        const isApprove = actionType === 'approve';
        const sender = 'user' in body ? body.user?.id || 'unknown' : 'unknown';
        const ok = respondToApproval(approvalId, isApprove, undefined, sender);

        if (ok) {
          const statusText = isApprove ? 'Approved' : 'Rejected';
          await respond({
            text: `*${statusText}* by ${sender}`,
            replace_original: true,
          });
        } else {
          await respond({
            text: 'Already resolved or not found.',
            replace_original: false,
            response_type: 'ephemeral',
          });
        }

        console.log(`[slack:${this.channelId}] ${isApprove ? 'Approved' : 'Rejected'} ${approvalId} by ${sender}`);
      });

      await this.app.start();
      console.log(`[slack:${this.channelId}] Connected via Socket Mode`);
      this.setStatus('connected');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus('error', msg);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = undefined;
    }
    this.webClient = undefined;
    this.setStatus('disconnected');
  }

  override async sendApprovalPrompt(
    externalChatId: string,
    approvalId: string,
    toolName: string,
    riskLevel: string,
  ): Promise<void> {
    if (!this.webClient) throw new Error('Slack client not connected');

    await this.webClient.chat.postMessage({
      channel: externalChatId,
      text: `*Approval required* [${riskLevel}]: \`${toolName}\``,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Approval required* [${riskLevel}]\nTool: \`${toolName}\``,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve' },
              style: 'primary',
              action_id: `approve:${approvalId}`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Reject' },
              style: 'danger',
              action_id: `reject:${approvalId}`,
            },
          ],
        },
      ],
    });
  }

  async sendMessage(externalChatId: string, text: string): Promise<void> {
    if (!this.webClient) throw new Error('Slack client not connected');

    // Slack message limit is ~40k chars, but split at 3000 for readability
    const maxLen = 3000;
    const chunks: string[] = [];
    if (text.length <= maxLen) {
      chunks.push(text);
    } else {
      let current = '';
      for (const paragraph of text.split('\n\n')) {
        if (current.length + paragraph.length + 2 > maxLen) {
          if (current) chunks.push(current);
          current = paragraph;
        } else {
          current = current ? current + '\n\n' + paragraph : paragraph;
        }
      }
      if (current) chunks.push(current);
    }

    for (const chunk of chunks) {
      await this.webClient.chat.postMessage({
        channel: externalChatId,
        text: chunk,
      });
    }
  }
}
