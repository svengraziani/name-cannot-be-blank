import { ChannelAdapter, IncomingMessage } from './base';
import { v4 as uuid } from 'uuid';

export interface WidgetConfig {
  title?: string;
  subtitle?: string;
  primaryColor?: string;
  position?: 'bottom-right' | 'bottom-left';
  welcomeMessage?: string;
  placeholder?: string;
  allowedOrigins?: string[];
}

const DEFAULT_WIDGET_CONFIG: Required<WidgetConfig> = {
  title: 'Chat',
  subtitle: 'Ask us anything',
  primaryColor: '#6366f1',
  position: 'bottom-right',
  welcomeMessage: 'Hello! How can I help you today?',
  placeholder: 'Type your message...',
  allowedOrigins: [],
};

/**
 * WebWidget channel adapter for embeddable chat widgets.
 *
 * Each widget instance connects via WebSocket at /widget/:channelId.
 * Visitors are identified by a session ID stored in their browser.
 * Messages flow through the standard channel manager pipeline.
 */
export class WebWidgetAdapter extends ChannelAdapter {
  public config: Required<WidgetConfig>;
  private clients = new Map<string, any>(); // sessionId -> ws

  constructor(channelId: string, widgetConfig: WidgetConfig) {
    super(channelId, 'web-widget');
    this.config = { ...DEFAULT_WIDGET_CONFIG, ...widgetConfig };
  }

  override async connect(): Promise<void> {
    this.setStatus('connected');
    console.log(`[web-widget] Channel ${this.channelId} ready for connections`);
  }

  override async disconnect(): Promise<void> {
    for (const [, ws] of this.clients) {
      try {
        ws.close(1000, 'Channel disconnected');
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.setStatus('disconnected');
  }

  override async sendMessage(externalChatId: string, text: string): Promise<void> {
    const ws = this.clients.get(externalChatId);
    if (!ws || ws.readyState !== 1) {
      console.warn(`[web-widget] No active connection for session ${externalChatId}`);
      return;
    }
    try {
      ws.send(JSON.stringify({ type: 'message', text, ts: Date.now() }));
    } catch (err) {
      console.error(`[web-widget] Failed to send to ${externalChatId}:`, err);
      this.clients.delete(externalChatId);
    }
  }

  /**
   * Handle a new WebSocket connection from a widget visitor.
   */
  handleConnection(ws: any, sessionId?: string): string {
    const id = sessionId || uuid();

    this.clients.set(id, ws);
    console.log(`[web-widget] Visitor connected: ${id} (total: ${this.clients.size})`);

    // Send welcome config
    ws.send(
      JSON.stringify({
        type: 'connected',
        sessionId: id,
        config: {
          title: this.config.title,
          subtitle: this.config.subtitle,
          primaryColor: this.config.primaryColor,
          welcomeMessage: this.config.welcomeMessage,
          placeholder: this.config.placeholder,
        },
      }),
    );

    ws.on('message', (raw: string) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === 'message' && data.text?.trim()) {
          const msg: IncomingMessage = {
            channelId: this.channelId,
            channelType: 'web-widget',
            externalChatId: id,
            sender: `widget-${id.slice(0, 8)}`,
            text: data.text.trim(),
            chatTitle: `Widget Chat ${id.slice(0, 8)}`,
          };
          this.emit('message', msg);
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      this.clients.delete(id);
      console.log(`[web-widget] Visitor disconnected: ${id} (total: ${this.clients.size})`);
    });

    return id;
  }

  /**
   * Check if an origin is allowed to connect.
   */
  isOriginAllowed(origin: string | undefined): boolean {
    // If no origins configured, allow all
    if (!this.config.allowedOrigins.length) return true;
    if (!origin) return false;
    return this.config.allowedOrigins.some(
      (allowed) => origin === allowed || origin.endsWith('.' + allowed.replace(/^https?:\/\//, '')),
    );
  }

  override getStatusInfo(): Record<string, unknown> {
    return {
      activeConnections: this.clients.size,
      config: this.config,
    };
  }
}
