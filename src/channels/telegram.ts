import TelegramBot from 'node-telegram-bot-api';
import { ChannelAdapter, IncomingMessage } from './base';

export interface TelegramConfig {
  botToken: string;
  allowedUsers: string[];
}

export class TelegramAdapter extends ChannelAdapter {
  private bot?: TelegramBot;
  private readonly conf: TelegramConfig;

  constructor(channelId: string, conf: TelegramConfig) {
    super(channelId, 'telegram');
    this.conf = conf;
  }

  async connect(): Promise<void> {
    if (!this.conf.botToken) {
      this.setStatus('error', 'No bot token configured');
      return;
    }

    this.setStatus('connecting');

    try {
      this.bot = new TelegramBot(this.conf.botToken, { polling: true });

      this.bot.on('message', (msg) => {
        if (!msg.text) return;

        const userId = String(msg.from?.id || '');
        if (this.conf.allowedUsers.length > 0 && !this.conf.allowedUsers.includes(userId)) {
          return; // Ignore unauthorized users
        }

        const incoming: IncomingMessage = {
          channelId: this.channelId,
          channelType: 'telegram',
          externalChatId: String(msg.chat.id),
          sender: msg.from?.username || msg.from?.first_name || userId,
          text: msg.text,
          chatTitle: msg.chat.title || msg.chat.first_name || undefined,
        };

        this.emit('message', incoming);
      });

      this.bot.on('polling_error', (err) => {
        console.error(`[telegram:${this.channelId}] Polling error:`, err.message);
      });

      // Verify connection by getting bot info
      const me = await this.bot.getMe();
      console.log(`[telegram:${this.channelId}] Connected as @${me.username}`);
      this.setStatus('connected');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus('error', msg);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling();
      this.bot = undefined;
    }
    this.setStatus('disconnected');
  }

  async sendMessage(externalChatId: string, text: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not connected');

    // Split long messages (Telegram limit: 4096 chars)
    const maxLen = 4000;
    if (text.length <= maxLen) {
      await this.bot.sendMessage(externalChatId, text);
    } else {
      for (let i = 0; i < text.length; i += maxLen) {
        await this.bot.sendMessage(externalChatId, text.slice(i, i + maxLen));
      }
    }
  }
}
