import { ChannelAdapter, IncomingMessage } from './base';
import * as fs from 'fs';
import * as path from 'path';

// Baileys types - dynamic import to handle optional dependency
type WASocket = any;

const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 3000;
const MAX_BACKOFF_MS = 30000;
const MAX_QR_RETRIES = 3;

export class WhatsAppAdapter extends ChannelAdapter {
  private sock?: WASocket;
  private _qrCode?: string;
  private _qrDataUrl?: string;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private qrRetries = 0;
  private stopping = false;

  constructor(channelId: string) {
    super(channelId, 'whatsapp');
  }

  get qrCode(): string | undefined {
    return this._qrCode;
  }

  private get authDir(): string {
    return `/data/whatsapp-auth-${this.channelId}`;
  }

  private clearAuthState(): void {
    try {
      if (fs.existsSync(this.authDir)) {
        const files = fs.readdirSync(this.authDir);
        for (const file of files) {
          fs.unlinkSync(path.join(this.authDir, file));
        }
        fs.rmdirSync(this.authDir);
        console.log(`[whatsapp:${this.channelId}] Cleared stale auth state`);
      }
    } catch (err) {
      console.warn(`[whatsapp:${this.channelId}] Failed to clear auth state:`, err);
    }
  }

  async connect(): Promise<void> {
    this.stopping = false;
    this.setStatus('connecting');

    try {
      // Clean up previous socket if any
      if (this.sock) {
        try {
          this.sock.end(undefined);
        } catch {
          /* ignored */
        }
        this.sock = undefined;
      }

      // Dynamic import of baileys
      const {
        default: makeWASocket,
        useMultiFileAuthState,
        DisconnectReason,
        Browsers,
        fetchLatestBaileysVersion,
      } = await import('baileys');

      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

      // Fetch latest WA Web version - the bundled version expires regularly,
      // causing 405 rejections during device registration
      let version: [number, number, number] | undefined;
      try {
        const versionInfo = await fetchLatestBaileysVersion();
        if (versionInfo.version) {
          version = versionInfo.version;
          console.log(`[whatsapp:${this.channelId}] Using WA version: ${version.join('.')}`);
        }
      } catch (_err) {
        console.warn(`[whatsapp:${this.channelId}] Failed to fetch latest version, using bundled default`);
      }

      this.sock = makeWASocket({
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 20000,
        qrTimeout: 40000,
        ...(version ? { version } : {}),
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', (update: any) => {
        if (this.stopping) return;

        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this._qrCode = qr;
          this.qrRetries++;
          this.reconnectAttempts = 0; // Reset reconnect counter when QR is shown
          this.emit('qr', qr);
          console.log(
            `[whatsapp:${this.channelId}] QR code generated (attempt ${this.qrRetries}/${MAX_QR_RETRIES}) - scan via Web UI`,
          );

          if (this.qrRetries > MAX_QR_RETRIES) {
            console.log(`[whatsapp:${this.channelId}] QR not scanned after ${MAX_QR_RETRIES} attempts, giving up`);
            this.setStatus('error', 'QR code expired. Delete and recreate the channel to try again.');
            this.sock?.end(undefined);
            return;
          }
        }

        if (connection === 'open') {
          this._qrCode = undefined;
          this._qrDataUrl = undefined;
          this.reconnectAttempts = 0;
          this.qrRetries = 0;
          this.setStatus('connected');
          console.log(`[whatsapp:${this.channelId}] Connected successfully`);
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const errorMsg = (lastDisconnect?.error as any)?.message || 'Unknown error';

          console.log(`[whatsapp:${this.channelId}] Connection closed: code=${statusCode} error="${errorMsg}"`);

          if (statusCode === DisconnectReason.loggedOut) {
            // Logged out: clear auth and stop
            console.log(`[whatsapp:${this.channelId}] Logged out, clearing auth state`);
            this.clearAuthState();
            this.setStatus('disconnected');
            return;
          }

          if (statusCode === DisconnectReason.restartRequired) {
            // Restart required: reconnect immediately once
            console.log(`[whatsapp:${this.channelId}] Restart required, reconnecting...`);
            this.reconnectAttempts = 0;
            this.scheduleReconnect(1000);
            return;
          }

          // 405 = WhatsApp rejected stored credentials (stale/corrupt auth state)
          // Clear auth immediately so next attempt gets a fresh QR code
          if (statusCode === 405) {
            console.log(`[whatsapp:${this.channelId}] 405 rejection - clearing corrupt auth state for fresh QR`);
            this.clearAuthState();
            this.reconnectAttempts++;
            if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
              this.setStatus('error', 'WhatsApp rejected credentials repeatedly. Delete and recreate the channel.');
              return;
            }
            this.scheduleReconnect(2000);
            return;
          }

          // For other errors: reconnect with backoff
          this.reconnectAttempts++;

          if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            console.log(`[whatsapp:${this.channelId}] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`);
            // Clear potentially corrupt auth state so next connect gets fresh QR
            this.clearAuthState();
            this.setStatus(
              'error',
              `Connection failed after ${MAX_RECONNECT_ATTEMPTS} attempts. Auth state cleared. Delete and recreate, or restart the gateway.`,
            );
            return;
          }

          const backoff = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, this.reconnectAttempts - 1), MAX_BACKOFF_MS);
          console.log(
            `[whatsapp:${this.channelId}] Reconnecting in ${backoff}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
          );
          this.scheduleReconnect(backoff);
        }
      });

      this.sock.ev.on('messages.upsert', (upsert: any) => {
        if (this.stopping) return;

        for (const msg of upsert.messages) {
          if (!msg.message || msg.key.fromMe) continue;

          const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

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
      console.error(`[whatsapp:${this.channelId}] Connect error:`, msg);
      this.setStatus('error', msg);
      throw err;
    }
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.stopping) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.reconnectTimer = setTimeout(() => {
      if (!this.stopping) {
        this.connect().catch((err) => {
          console.error(`[whatsapp:${this.channelId}] Reconnect failed:`, err);
        });
      }
    }, delayMs);
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        /* ignored */
      }
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

  override getStatusInfo(): Record<string, unknown> {
    return {
      qrCode: this._qrCode,
      qrDataUrl: this._qrDataUrl,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}
