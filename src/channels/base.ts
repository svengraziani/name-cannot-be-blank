import { EventEmitter } from 'events';

export interface IncomingMessage {
  channelId: string;
  channelType: string;
  externalChatId: string;
  sender: string;
  text: string;
  chatTitle?: string;
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
   * Send a voice/audio message (if supported by channel).
   * Default: not implemented. Override in adapters that support voice (e.g. Telegram).
   */
  async sendVoice(_externalChatId: string, _audio: Buffer): Promise<void> {
    // Voice messages not supported by default
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
