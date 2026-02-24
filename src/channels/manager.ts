import { v4 as uuid } from 'uuid';
import QRCode from 'qrcode';
import { ChannelAdapter, IncomingMessage } from './base';
import { TelegramAdapter, TelegramConfig } from './telegram';
import { WhatsAppAdapter } from './whatsapp';
import { EmailAdapter, EmailConfig } from './email';
import {
  getAllChannels,
  upsertChannel,
  updateChannelStatus,
  deleteChannel as dbDeleteChannel,
  getOrCreateConversation,
  ChannelRow,
} from '../db/sqlite';
import { processMessage, agentEvents } from '../agent/loop';
import { resolveAgentConfig, checkGroupBudget } from '../agent/groups/resolver';
import { getSystemPrompt } from '../agent/loop';
import { EventEmitter } from 'events';

export const channelManagerEvents = new EventEmitter();

// Active channel adapters
const adapters = new Map<string, ChannelAdapter>();

/**
 * Initialize channels from database on startup.
 */
export async function initChannels(): Promise<void> {
  const channels = getAllChannels();
  for (const ch of channels) {
    if (ch.enabled) {
      try {
        await startChannel(ch);
      } catch (err) {
        console.error(`[manager] Failed to start channel ${ch.id} (${ch.type}):`, err);
      }
    }
  }
  console.log(`[manager] ${adapters.size} channel(s) active`);
}

/**
 * Create and start a new channel.
 */
export async function createChannel(
  type: string,
  name: string,
  channelConfig: Record<string, unknown>,
): Promise<string> {
  const id = uuid();
  upsertChannel({
    id,
    type,
    name,
    config: JSON.stringify(channelConfig),
    enabled: 1,
  });

  const row = { id, type, name, config: JSON.stringify(channelConfig), enabled: 1, status: 'disconnected', created_at: '', updated_at: '' };
  await startChannel(row);
  return id;
}

/**
 * Update an existing channel's config and restart it.
 */
export async function updateChannel(
  id: string,
  updates: { name?: string; config?: Record<string, unknown>; enabled?: boolean },
): Promise<void> {
  const existing = getAllChannels().find(c => c.id === id);
  if (!existing) throw new Error(`Channel ${id} not found`);

  // Stop the existing adapter
  await stopChannel(id);

  upsertChannel({
    id,
    type: existing.type,
    name: updates.name ?? existing.name,
    config: updates.config ? JSON.stringify(updates.config) : existing.config,
    enabled: updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : existing.enabled,
  });

  if (updates.enabled !== false) {
    const row = getAllChannels().find(c => c.id === id)!;
    await startChannel(row);
  }
}

/**
 * Delete a channel completely.
 */
export async function removeChannel(id: string): Promise<void> {
  await stopChannel(id);
  dbDeleteChannel(id);
}

/**
 * Get a channel adapter by ID (for output routing).
 */
export function getChannelAdapter(channelId: string): ChannelAdapter | undefined {
  return adapters.get(channelId);
}

/**
 * Get status of all channels.
 */
export function getChannelStatuses(): Array<{
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  status: string;
  statusInfo: Record<string, unknown>;
  agentGroupId?: string;
}> {
  const channels = getAllChannels();
  return channels.map(ch => {
    const adapter = adapters.get(ch.id);
    return {
      id: ch.id,
      type: ch.type,
      name: ch.name,
      enabled: ch.enabled === 1,
      status: adapter?.status || ch.status,
      statusInfo: adapter?.getStatusInfo() || {},
      agentGroupId: (ch as any).agent_group_id || undefined,
    };
  });
}

// --- Internal helpers ---

async function startChannel(ch: ChannelRow): Promise<void> {
  if (adapters.has(ch.id)) {
    await stopChannel(ch.id);
  }

  const conf = JSON.parse(ch.config);
  let adapter: ChannelAdapter;

  switch (ch.type) {
    case 'telegram':
      adapter = new TelegramAdapter(ch.id, conf as TelegramConfig);
      break;
    case 'whatsapp':
      adapter = new WhatsAppAdapter(ch.id);
      break;
    case 'email':
      adapter = new EmailAdapter(ch.id, conf as EmailConfig);
      break;
    default:
      throw new Error(`Unknown channel type: ${ch.type}`);
  }

  // Extract enabled tools from channel config (legacy, overridden by group)
  const enabledTools = conf.tools as string[] | undefined;
  if (enabledTools?.length) {
    console.log(`[manager] Channel ${ch.id} (${ch.type}) tools: ${enabledTools.join(', ')}`);
  }

  // Wire up incoming messages to the agent loop
  adapter.on('message', async (msg: IncomingMessage) => {
    console.log(`[manager] Message from ${msg.channelType}/${msg.sender}: ${msg.text.slice(0, 100)}`);

    const conversationId = getOrCreateConversation(msg.channelId, msg.externalChatId, msg.chatTitle);

    channelManagerEvents.emit('message:incoming', {
      channelId: msg.channelId,
      channelType: msg.channelType,
      sender: msg.sender,
      text: msg.text.slice(0, 200),
    });

    try {
      // Resolve agent config from group (or use global defaults)
      const agentConfig = resolveAgentConfig(msg.channelId, getSystemPrompt());

      // Check budget limits if group is assigned
      if (agentConfig.groupId) {
        const budgetError = checkGroupBudget(agentConfig.groupId);
        if (budgetError) {
          console.warn(`[manager] Budget exceeded for group ${agentConfig.groupId}: ${budgetError}`);
          await adapter.sendMessage(msg.externalChatId, `Budget limit reached: ${budgetError}`);
          return;
        }
      }

      const reply = await processMessage(
        conversationId,
        msg.text,
        msg.channelType,
        msg.sender,
        enabledTools,
        agentConfig,
      );
      await adapter.sendMessage(msg.externalChatId, reply);

      channelManagerEvents.emit('message:reply', {
        channelId: msg.channelId,
        channelType: msg.channelType,
        replyLength: reply.length,
        groupId: agentConfig.groupId,
      });
    } catch (err) {
      console.error(`[manager] Failed to process/reply:`, err);
      try {
        await adapter.sendMessage(
          msg.externalChatId,
          'Sorry, an error occurred while processing your message. Please try again.',
        );
      } catch {
        // ignore send failure
      }
    }
  });

  // Forward status changes
  adapter.on('status', (statusUpdate: { channelId: string; status: string; error?: string }) => {
    updateChannelStatus(statusUpdate.channelId, statusUpdate.status);
    channelManagerEvents.emit('channel:status', statusUpdate);
  });

  // Forward WhatsApp QR codes (convert raw string to data URL)
  adapter.on('qr', async (qr: string) => {
    try {
      const dataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
      // Store data URL on adapter so it's available via getStatusInfo()
      if (adapter instanceof WhatsAppAdapter) {
        adapter.setQrDataUrl(dataUrl);
      }
      channelManagerEvents.emit('whatsapp:qr', { channelId: ch.id, qr: dataUrl });
    } catch (err) {
      console.error(`[manager] Failed to generate QR code:`, err);
      channelManagerEvents.emit('whatsapp:qr', { channelId: ch.id, qr: '' });
    }
  });

  adapters.set(ch.id, adapter);

  try {
    await adapter.connect();
  } catch (err) {
    console.error(`[manager] Channel ${ch.id} connect failed:`, err);
  }
}

async function stopChannel(id: string): Promise<void> {
  const adapter = adapters.get(id);
  if (adapter) {
    try {
      await adapter.disconnect();
    } catch (err) {
      console.error(`[manager] Channel ${id} disconnect error:`, err);
    }
    adapters.delete(id);
  }
}
