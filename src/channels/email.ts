import { ChannelAdapter, IncomingMessage } from './base';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

export interface EmailConfig {
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPass: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  pollIntervalMs: number;
  allowedSenders: string[];
}

export class EmailAdapter extends ChannelAdapter {
  private imap?: Imap;
  private transporter?: nodemailer.Transporter;
  private pollTimer?: NodeJS.Timeout;
  private readonly conf: EmailConfig;

  constructor(channelId: string, conf: EmailConfig) {
    super(channelId, 'email');
    this.conf = conf;
  }

  async connect(): Promise<void> {
    if (!this.conf.imapHost || !this.conf.imapUser) {
      this.setStatus('error', 'IMAP not configured');
      return;
    }

    this.setStatus('connecting');

    try {
      // Setup SMTP transporter
      if (this.conf.smtpHost) {
        this.transporter = nodemailer.createTransport({
          host: this.conf.smtpHost,
          port: this.conf.smtpPort,
          secure: this.conf.smtpPort === 465,
          auth: {
            user: this.conf.smtpUser,
            pass: this.conf.smtpPass,
          },
        });
      }

      // Setup IMAP
      this.imap = new Imap({
        user: this.conf.imapUser,
        password: this.conf.imapPass,
        host: this.conf.imapHost,
        port: this.conf.imapPort,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
      });

      await new Promise<void>((resolve, reject) => {
        this.imap!.once('ready', () => resolve());
        this.imap!.once('error', (err: Error) => reject(err));
        this.imap!.connect();
      });

      console.log(`[email:${this.channelId}] IMAP connected`);
      this.setStatus('connected');

      // Start polling for new emails
      await this.pollEmails();
      this.pollTimer = setInterval(() => {
        void this.pollEmails();
      }, this.conf.pollIntervalMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus('error', msg);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.imap) {
      this.imap.end();
      this.imap = undefined;
    }
    this.transporter = undefined;
    this.setStatus('disconnected');
  }

  async sendMessage(externalChatId: string, text: string): Promise<void> {
    if (!this.transporter) throw new Error('SMTP not configured');

    await this.transporter.sendMail({
      from: this.conf.smtpUser,
      to: externalChatId,
      subject: 'Re: Agent Response',
      text,
    });
  }

  private async pollEmails(): Promise<void> {
    if (!this.imap || this.imap.state !== 'authenticated') return;

    try {
      await new Promise<void>((resolve, reject) => {
        this.imap!.openBox('INBOX', false, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });

      // Search for unseen messages
      const uids: number[] = await new Promise((resolve, reject) => {
        this.imap!.search(['UNSEEN'], (err, results) => {
          if (err) return reject(err);
          resolve(results || []);
        });
      });

      if (uids.length === 0) return;

      const fetch = this.imap!.fetch(uids, { bodies: '', markSeen: true });

      fetch.on('message', (msg: any) => {
        msg.on('body', (stream: NodeJS.ReadableStream) => {
          simpleParser(stream as any)
            .then((parsed) => {
              const from = parsed.from?.value?.[0]?.address || '';
              const text = parsed.text || '';

              if (!text) return;

              // Filter by allowed senders
              if (this.conf.allowedSenders.length > 0 && !this.conf.allowedSenders.includes(from)) {
                return;
              }

              const incoming: IncomingMessage = {
                channelId: this.channelId,
                channelType: 'email',
                externalChatId: from,
                sender: parsed.from?.value?.[0]?.name || from,
                text,
                chatTitle: parsed.subject || undefined,
              };

              this.emit('message', incoming);
            })
            .catch((err) => {
              console.error(`[email:${this.channelId}] Parse error:`, err);
            });
        });
      });
    } catch (err) {
      console.error(`[email:${this.channelId}] Poll error:`, err);
    }
  }

  override getStatusInfo(): Record<string, unknown> {
    return {
      imapHost: this.conf.imapHost,
      smtpHost: this.conf.smtpHost,
    };
  }
}
