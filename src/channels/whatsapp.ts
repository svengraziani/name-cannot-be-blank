import { ChannelAdapter, IncomingMessage } from './base';

// Baileys types - dynamic import to handle optional dependency
type WASocket = any;

export class WhatsAppAdapter extends ChannelAdapter {
  private sock?: WASocket;
  private _qrCode?: string;
  private _qrDataUrl?: string;

  constructor(channelId: string) {
    super(channelId, 'whatsapp');
  }

  get qrCode(): string | undefined {
    return this._qrCode;
  }

  async connect(): Promise<void> {
    this.setStatus('connecting');

    try {
      // Dynamic import of baileys
      const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await import('baileys');
      const { Boom } = await import('@hapi/boom');

      const authDir = `/data/whatsapp-auth-${this.channelId}`;
      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      this.sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this._qrCode = qr;
          this.emit('qr', qr);
          console.log(`[whatsapp:${this.channelId}] QR code generated - scan via Web UI`);
        }

        if (connection === 'open') {
          this._qrCode = undefined;
          this._qrDataUrl = undefined;
          this.setStatus('connected');
          console.log(`[whatsapp:${this.channelId}] Connected`);
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          if (shouldReconnect) {
            console.log(`[whatsapp:${this.channelId}] Reconnecting...`);
            this.connect();
          } else {
            this.setStatus('disconnected');
            console.log(`[whatsapp:${this.channelId}] Logged out`);
          }
        }
      });

      this.sock.ev.on('messages.upsert', (upsert: any) => {
        for (const msg of upsert.messages) {
          if (!msg.message || msg.key.fromMe) continue;

          const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            '';

          if (!text) continue;

          const incoming: IncomingMessage = {
            channelId: this.channelId,
            channelType: 'whatsapp',
            externalChatId: msg.key.remoteJid || '',
            sender: msg.pushName || msg.key.participant || msg.key.remoteJid || 'unknown',
            text,
            chatTitle: msg.key.remoteJid || undefined,
          };

          this.emit('message', incoming);
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus('error', msg);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = undefined;
    }
    this.setStatus('disconnected');
  }

  async sendMessage(externalChatId: string, text: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp not connected');
    await this.sock.sendMessage(externalChatId, { text });
  }

  /** Store the data URL after conversion by the manager */
  setQrDataUrl(dataUrl: string): void {
    this._qrDataUrl = dataUrl;
  }

  getStatusInfo(): Record<string, unknown> {
    return {
      qrCode: this._qrCode,
      qrDataUrl: this._qrDataUrl,
    };
  }
}
