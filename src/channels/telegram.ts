import TelegramBot from 'node-telegram-bot-api';
import { ChannelAdapter, IncomingMessage } from './base';

export interface TelegramConfig {
  botToken: string;
  allowedUsers: string[];
}

/**
 * Convert Markdown from Claude's output to Telegram-compatible HTML.
 * Telegram supports: <b>, <i>, <code>, <pre>, <a>, <blockquote>
 * but NOT headers, lists, or other Markdown constructs.
 */
function markdownToTelegramHtml(text: string): string {
  let result = text;

  // Escape HTML entities first (but preserve existing valid chars)
  result = result
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks (``` ... ```) - must be before inline code
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre>${code.trim()}</pre>`;
  });

  // Inline code (`...`)
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold + Italic (***text*** or ___text___)
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>');

  // Bold (**text**)
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // Italic (*text* - but not inside bold tags)
  result = result.replace(/(?<![<\w])\*([^*]+?)\*(?![>\w])/g, '<i>$1</i>');

  // Strikethrough (~~text~~)
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Headers (## text → bold text) - Telegram has no header support
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Blockquotes (> text)
  result = result.replace(/^(?:&gt;)\s?(.+)$/gm, '<blockquote>$1</blockquote>');
  // Merge consecutive blockquotes
  result = result.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  return result;
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

    const html = markdownToTelegramHtml(text);

    // Split long messages (Telegram limit: 4096 chars)
    const maxLen = 4000;
    if (html.length <= maxLen) {
      await this.bot.sendMessage(externalChatId, html, { parse_mode: 'HTML' });
    } else {
      // Split on double newlines to avoid breaking mid-tag
      const chunks: string[] = [];
      let current = '';
      for (const paragraph of html.split('\n\n')) {
        if (current.length + paragraph.length + 2 > maxLen) {
          if (current) chunks.push(current);
          current = paragraph;
        } else {
          current = current ? current + '\n\n' + paragraph : paragraph;
        }
      }
      if (current) chunks.push(current);

      for (const chunk of chunks) {
        await this.bot.sendMessage(externalChatId, chunk, { parse_mode: 'HTML' });
      }
    }
  }
}
