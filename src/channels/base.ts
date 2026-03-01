import { EventEmitter } from 'events';

export interface IncomingMessage {
  channelId: string;
  channelType: string;
  externalChatId: string;
  sender: string;
  text: string;
  chatTitle?: string;
}

export interface OutgoingFile {
  filename: string;
  mimeType: string;
  data: Buffer;
  caption?: string;
}

/**
 * Base class for all channel adapters.
 * Emits 'message' events when incoming messages arrive.
 * Subclasses implement connect(), disconnect(), and sendMessage().
 */
export abstract class ChannelAdapter extends EventEmitter {
  public readonly channelId: string;
  public readonly channelType: string;
  public status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  public lastError?: string;

  constructor(channelId: string, channelType: string) {
    super();
    this.channelId = channelId;
    this.channelType = channelType;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract sendMessage(externalChatId: string, text: string): Promise<void>;

  /**
   * Send a file attachment through the channel.
   * Default implementation saves to /tmp and sends a text link.
   * Subclasses should override with native file sending where supported.
   */
  async sendFile(externalChatId: string, file: OutgoingFile): Promise<void> {
    const fs = await import('fs');
    const path = await import('path');
    const tmpPath = path.join('/tmp', `lg-${Date.now()}-${file.filename}`);
    fs.writeFileSync(tmpPath, file.data);
    await this.sendMessage(
      externalChatId,
      `${file.caption || 'File generated'}: ${file.filename} (${Math.round(file.data.length / 1024)}KB)\nSaved to: ${tmpPath}`,
    );
  }

  /**
   * Send an approval prompt with interactive buttons (if supported by channel).
   * Default implementation sends a plain text message with /approve and /reject commands.
   */
  async sendApprovalPrompt(
    externalChatId: string,
    approvalId: string,
    toolName: string,
    riskLevel: string,
  ): Promise<void> {
    await this.sendMessage(
      externalChatId,
      `**Approval required** (${riskLevel}): \`${toolName}\`\n\n` +
        `/approve ${approvalId}\n` +
        `/reject ${approvalId}`,
    );
  }

  /** Override to return channel-specific status info (e.g. QR code for WhatsApp) */
  getStatusInfo(): Record<string, unknown> {
    return {};
  }

  protected setStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error', error?: string): void {
    this.status = status;
    this.lastError = error;
    this.emit('status', { channelId: this.channelId, status, error });
  }
}
