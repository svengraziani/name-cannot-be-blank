import { Client, GatewayIntentBits, Message, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { ChannelAdapter, IncomingMessage } from './base';
import { respondToApproval } from '../agent/hitl';

export interface DiscordConfig {
  botToken: string;
  /** Allowed channel IDs (empty = all channels) */
  allowedChannels: string[];
  /** Allowed user IDs (empty = all users) */
  allowedUsers: string[];
}

export class DiscordAdapter extends ChannelAdapter {
  private client?: Client;
  private readonly conf: DiscordConfig;

  constructor(channelId: string, conf: DiscordConfig) {
    super(channelId, 'discord');
    this.conf = conf;
  }

  async connect(): Promise<void> {
    if (!this.conf.botToken) {
      this.setStatus('error', 'No bot token configured');
      return;
    }

    this.setStatus('connecting');

    try {
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel],
      });

      this.client.on('messageCreate', (msg: Message) => {
        // Ignore bot messages
        if (msg.author.bot) return;
        if (!msg.content) return;

        // Filter by allowed channels
        if (this.conf.allowedChannels.length > 0 && !this.conf.allowedChannels.includes(msg.channelId)) {
          return;
        }

        // Filter by allowed users
        if (this.conf.allowedUsers.length > 0 && !this.conf.allowedUsers.includes(msg.author.id)) {
          return;
        }

        const incoming: IncomingMessage = {
          channelId: this.channelId,
          channelType: 'discord',
          externalChatId: msg.channelId,
          sender: msg.author.tag || msg.author.username || msg.author.id,
          text: msg.content,
          chatTitle: msg.guild?.name || 'DM',
        };

        this.emit('message', incoming);
      });

      // Handle button interactions (approve/reject)
      this.client.on('interactionCreate', (interaction) => {
        void (async () => {
          if (!interaction.isButton()) return;

          const [action, approvalId] = interaction.customId.split(':');
          if ((action === 'approve' || action === 'reject') && approvalId) {
            const isApprove = action === 'approve';
            const sender = interaction.user.tag || interaction.user.username;
            const ok = respondToApproval(approvalId, isApprove, undefined, sender);

            if (ok) {
              const statusText = isApprove ? 'Approved' : 'Rejected';
              await interaction.update({
                content: `${interaction.message.content}\n\n**${statusText}** by ${sender}`,
                components: [],
              });
            } else {
              await interaction.reply({
                content: 'Already resolved or not found.',
                ephemeral: true,
              });
            }

            console.log(
              `[discord:${this.channelId}] ${isApprove ? 'Approved' : 'Rejected'} ${approvalId} by ${sender}`,
            );
          }
        })();
      });

      await this.client.login(this.conf.botToken);
      console.log(`[discord:${this.channelId}] Connected as ${this.client.user?.tag}`);
      this.setStatus('connected');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus('error', msg);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = undefined;
    }
    this.setStatus('disconnected');
  }

  override async sendApprovalPrompt(
    externalChatId: string,
    approvalId: string,
    toolName: string,
    riskLevel: string,
  ): Promise<void> {
    if (!this.client) throw new Error('Discord client not connected');

    const channel = await this.client.channels.fetch(externalChatId);
    if (!channel || !channel.isTextBased()) throw new Error('Channel not found or not text-based');

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`approve:${approvalId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`reject:${approvalId}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
    );

    await (channel as any).send({
      content: `**Approval required** [${riskLevel}]\nTool: \`${toolName}\``,
      components: [row],
    });
  }

  async sendMessage(externalChatId: string, text: string): Promise<void> {
    if (!this.client) throw new Error('Discord client not connected');

    const channel = await this.client.channels.fetch(externalChatId);
    if (!channel || !channel.isTextBased()) throw new Error('Channel not found or not text-based');

    // Discord message limit is 2000 chars
    const maxLen = 1990;
    const chunks: string[] = [];
    if (text.length <= maxLen) {
      chunks.push(text);
    } else {
      let current = '';
      for (const paragraph of text.split('\n\n')) {
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
      await (channel as any).send(chunk);
    }
  }
}
