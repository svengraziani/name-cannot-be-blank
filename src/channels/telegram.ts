import TelegramBot from 'node-telegram-bot-api';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import { ChannelAdapter, IncomingMessage } from './base';
import { respondToApproval } from '../agent/hitl';
import { storeFile, FileAttachment, validateMimeType } from '../files';

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

  // Code blocks (``` ... ```) - extract to placeholders so inline
  // conversions (bold, italic, etc.) don't corrupt their content.
  const codeBlocks: string[] = [];
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre>${code.trim()}</pre>`);
    return `\x00CB${idx}\x00`;
  });

  // Inline code (`...`) - also protect from further conversion
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${code}</code>`);
    return `\x00IC${idx}\x00`;
  });

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

  // Restore inline code placeholders
  result = result.replace(/\x00IC(\d+)\x00/g, (_m, idx) => inlineCodes[Number(idx)] ?? '');

  // Restore code block placeholders
  result = result.replace(/\x00CB(\d+)\x00/g, (_m, idx) => codeBlocks[Number(idx)] ?? '');

  return result;
}

/**
 * Download a file from a URL into a buffer.
 */
function downloadBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadBuffer(res.headers.location).then(resolve, reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
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

      this.bot.on('message', async (msg) => {
        const userId = String(msg.from?.id || '');
        if (this.conf.allowedUsers.length > 0 && !this.conf.allowedUsers.includes(userId)) {
          return; // Ignore unauthorized users
        }

        const text = msg.text || msg.caption || '';
        const attachments: FileAttachment[] = [];

        // Handle photo attachments
        if (msg.photo && msg.photo.length > 0) {
          try {
            // Get highest resolution photo
            const photo = msg.photo[msg.photo.length - 1]!;
            const attachment = await this.downloadTelegramFile(photo.file_id, `photo_${photo.file_id}.jpg`, 'image/jpeg');
            if (attachment) attachments.push(attachment);
          } catch (err) {
            console.error(`[telegram:${this.channelId}] Failed to download photo:`, err);
          }
        }

        // Handle document attachments
        if (msg.document) {
          try {
            const mimeType = msg.document.mime_type || 'application/octet-stream';
            const filename = msg.document.file_name || `document_${msg.document.file_id}`;
            const attachment = await this.downloadTelegramFile(msg.document.file_id, filename, mimeType);
            if (attachment) attachments.push(attachment);
          } catch (err) {
            console.error(`[telegram:${this.channelId}] Failed to download document:`, err);
          }
        }

        // Skip messages with no text and no attachments
        if (!text && attachments.length === 0) return;

        const incoming: IncomingMessage = {
          channelId: this.channelId,
          channelType: 'telegram',
          externalChatId: String(msg.chat.id),
          sender: msg.from?.username || msg.from?.first_name || userId,
          text: text || '(file attached)',
          chatTitle: msg.chat.title || msg.chat.first_name || undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
        };

        this.emit('message', incoming);
      });

      // Handle inline keyboard button presses (approve/reject)
      this.bot.on('callback_query', async (query) => {
        if (!query.data || !query.message) return;
        const userId = String(query.from?.id || '');
        if (this.conf.allowedUsers.length > 0 && !this.conf.allowedUsers.includes(userId)) {
          return;
        }

        const [action, approvalId] = query.data.split(':');
        if ((action === 'approve' || action === 'reject') && approvalId) {
          const isApprove = action === 'approve';
          const sender = query.from?.username || query.from?.first_name || userId;
          const ok = respondToApproval(approvalId, isApprove, undefined, sender);

          // Answer the callback to remove the loading spinner
          await this.bot!.answerCallbackQuery(query.id, {
            text: ok
              ? `${isApprove ? 'Approved' : 'Rejected'}`
              : 'Already resolved or not found',
          });

          // Update the message to show the result (remove buttons)
          if (ok) {
            const statusText = isApprove ? 'Approved' : 'Rejected';
            try {
              await this.bot!.editMessageReplyMarkup(
                { inline_keyboard: [] },
                {
                  chat_id: query.message.chat.id,
                  message_id: query.message.message_id,
                },
              );
              await this.bot!.editMessageText(
                `${(query.message as TelegramBot.Message & { text?: string }).text}\n\n<b>${statusText}</b> by ${sender}`,
                {
                  chat_id: query.message.chat.id,
                  message_id: query.message.message_id,
                  parse_mode: 'HTML',
                },
              );
            } catch {
              // ignore edit failures (message might be too old)
            }
          }
          console.log(`[telegram:${this.channelId}] ${isApprove ? 'Approved' : 'Rejected'} ${approvalId} by ${sender}`);
        }
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

  override async sendApprovalPrompt(externalChatId: string, approvalId: string, toolName: string, riskLevel: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not connected');

    const text = `<b>Approval required</b> [${riskLevel}]\nTool: <code>${toolName}</code>`;

    await this.bot.sendMessage(externalChatId, text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Approve', callback_data: `approve:${approvalId}` },
            { text: 'Reject', callback_data: `reject:${approvalId}` },
          ],
        ],
      },
    });
  }

  async sendMessage(externalChatId: string, text: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not connected');

    const html = markdownToTelegramHtml(text);

    // Split long messages (Telegram limit: 4096 chars)
    const maxLen = 4000;
    const chunks: string[] = [];
    if (html.length <= maxLen) {
      chunks.push(html);
    } else {
      // Split on double newlines to avoid breaking mid-tag
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
    }

    for (const chunk of chunks) {
      try {
        await this.bot.sendMessage(externalChatId, chunk, { parse_mode: 'HTML' });
      } catch (err: unknown) {
        // If Telegram rejects the HTML (malformed tags), fall back to plain text
        const isParseError =
          err instanceof Error &&
          err.message.includes("can't parse entities");
        if (isParseError) {
          console.warn(`[telegram:${this.channelId}] HTML parse error, falling back to plain text`);
          const plain = chunk.replace(/<[^>]+>/g, '');
          await this.bot.sendMessage(externalChatId, plain);
        } else {
          throw err;
        }
      }
    }
  }

  override async sendFile(externalChatId: string, filePath: string, filename: string, mimeType: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram bot not connected');

    const stream = fs.createReadStream(filePath);

    if (mimeType.startsWith('image/')) {
      await this.bot.sendPhoto(externalChatId, stream as any, {}, { filename, contentType: mimeType });
    } else {
      await this.bot.sendDocument(externalChatId, stream as any, {}, { filename, contentType: mimeType });
    }
  }

  /**
   * Download a file from Telegram and store it.
   */
  private async downloadTelegramFile(
    fileId: string,
    filename: string,
    mimeType: string,
  ): Promise<FileAttachment | null> {
    if (!this.bot) return null;

    if (!validateMimeType(mimeType)) {
      console.log(`[telegram:${this.channelId}] Skipping unsupported file type: ${mimeType}`);
      return null;
    }

    const fileUrl = await this.bot.getFileLink(fileId);
    const buffer = await downloadBuffer(fileUrl);

    return storeFile(buffer, filename, mimeType, undefined, 'telegram');
  }
}
