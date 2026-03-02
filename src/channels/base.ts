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
   * Send an approval prompt with interactive buttons (if supported by channel).
   * Default implementation sends a plain text message with /approve and /reject commands.
   */
  async sendApprovalPrompt(externalChatId: string, approvalId: string, toolName: string, riskLevel: string): Promise<void> {
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

  /** Return structured health info for the channel. Override for channel-specific details. */
  getHealthInfo(): { status: string; connected: boolean; error?: string; details: Record<string, unknown> } {
    return {
      status: this.status,
      connected: this.status === 'connected',
      error: this.lastError,
      details: this.getStatusInfo(),
    };
  }

  protected setStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error', error?: string): void {
    this.status = status;
    this.lastError = error;
    this.emit('status', { channelId: this.channelId, status, error });
  }
}
