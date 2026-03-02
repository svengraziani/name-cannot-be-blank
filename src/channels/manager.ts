import { v4 as uuid } from 'uuid';
import QRCode from 'qrcode';
import { ChannelAdapter, IncomingMessage } from './base';
import { TelegramAdapter, TelegramConfig } from './telegram';
import { WhatsAppAdapter } from './whatsapp';
import { EmailAdapter, EmailConfig } from './email';
import { MattermostAdapter, MattermostConfig } from './mattermost';
import { DiscordAdapter, DiscordConfig } from './discord';
import { SlackAdapter, SlackConfig } from './slack';
import {
  getAllChannels,
  upsertChannel,
  updateChannelStatus,
  deleteChannel as dbDeleteChannel,
  getOrCreateConversation,
  ChannelRow,
  getConversation,
  clearConversationMessages,
  countConversationMessages,
} from '../db/sqlite';
import { processMessage } from '../agent/loop';
import { resolveAgentConfig, checkGroupBudget } from '../agent/groups/resolver';
import { getSystemPrompt } from '../agent/loop';
import { respondToApproval, approvalEvents } from '../agent/hitl';
import { EventEmitter } from 'events';

export const channelManagerEvents = new EventEmitter();

// Active channel adapters
const adapters = new Map<string, ChannelAdapter>();

// --- Per-conversation processing lock & message queue ---
// Prevents duplicate workflow runs when multiple messages arrive while the agent is busy.
interface QueuedMessage {
  msg: IncomingMessage;
  adapter: ChannelAdapter;
  enabledTools?: string[];
}
const conversationProcessing = new Set<string>();
const messageQueue = new Map<string, QueuedMessage[]>();

// Listen for approval requests and forward to the originating channel
approvalEvents.on(
  'approval:required',
  (approval: { id: string; conversationId: string; toolName: string; riskLevel: string }) => {
    const conv = getConversation(approval.conversationId);
    if (!conv) return;
    const adapter = adapters.get(conv.channelId);
    if (!adapter || adapter.status !== 'connected') return;

    adapter.sendApprovalPrompt(conv.externalId, approval.id, approval.toolName, approval.riskLevel).catch((err) => {
      console.error(`[manager] Failed to send approval prompt:`, err);
    });
  },
);

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

  const row = {
    id,
    type,
    name,
    config: JSON.stringify(channelConfig),
    enabled: 1,
    status: 'disconnected',
    created_at: '',
    updated_at: '',
  };
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
  const existing = getAllChannels().find((c) => c.id === id);
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
    const row = getAllChannels().find((c) => c.id === id)!;
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
  return channels.map((ch) => {
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
    case 'mattermost':
      adapter = new MattermostAdapter(ch.id, conf as MattermostConfig);
      break;
    case 'discord':
      adapter = new DiscordAdapter(ch.id, conf as DiscordConfig);
      break;
    case 'slack':
      adapter = new SlackAdapter(ch.id, conf as SlackConfig);
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
  adapter.on('message', (msg: IncomingMessage) => {
    void (async () => {
      console.log(`[manager] Message from ${msg.channelType}/${msg.sender}: ${msg.text.slice(0, 100)}`);

      // --- HITL commands: /approve <id> and /reject <id> ---
      // These bypass the queue since they resolve an existing pending approval,
      // not start a new agent run.
      const approveMatch = msg.text.match(/^\/approve\s+([0-9a-f-]{36})\s*(.*)?$/i);
      const rejectMatch = !approveMatch && msg.text.match(/^\/reject\s+([0-9a-f-]{36})\s*(.*)?$/i);

      if (approveMatch || rejectMatch) {
        const isApprove = !!approveMatch;
        const match = (approveMatch || rejectMatch) as RegExpMatchArray;
        const approvalId = match[1] as string;
        const reason = (match[2] as string | undefined)?.trim() || undefined;
        const ok = respondToApproval(approvalId, isApprove, reason, msg.sender);
        if (ok) {
          console.log(
            `[manager] ${isApprove ? 'Approved' : 'Rejected'} ${approvalId} via ${msg.channelType} by ${msg.sender}`,
          );
          await adapter.sendMessage(
            msg.externalChatId,
            `${isApprove ? 'Approved' : 'Rejected'} ${approvalId.slice(0, 8)}...`,
          );
        } else {
          await adapter.sendMessage(
            msg.externalChatId,
            `Approval ${approvalId.slice(0, 8)}... not found or already resolved.`,
          );
        }
        return;
      }
      // --- End HITL commands ---

      // --- Chat management commands (bypass queue) ---
      if (msg.text.match(/^\/reset$/i)) {
        const convId = getOrCreateConversation(msg.channelId, msg.externalChatId, msg.chatTitle);
        const deleted = clearConversationMessages(convId);
        console.log(`[manager] Conversation reset by ${msg.sender}: ${deleted} message(s) cleared`);
        await adapter.sendMessage(msg.externalChatId, `Conversation reset. ${deleted} message(s) cleared.`);
        return;
      }

      if (msg.text.match(/^\/status$/i)) {
        const convId = getOrCreateConversation(msg.channelId, msg.externalChatId, msg.chatTitle);
        const count = countConversationMessages(convId);
        await adapter.sendMessage(msg.externalChatId, `Conversation has ${count} message(s) in history.`);
        return;
      }
      // --- End chat management commands ---

      const conversationId = getOrCreateConversation(msg.channelId, msg.externalChatId, msg.chatTitle);

      channelManagerEvents.emit('message:incoming', {
        channelId: msg.channelId,
        channelType: msg.channelType,
        sender: msg.sender,
        text: msg.text.slice(0, 200),
      });

      // --- Per-conversation lock: queue messages while the agent is busy ---
      if (conversationProcessing.has(conversationId)) {
        const queue = messageQueue.get(conversationId) || [];
        queue.push({ msg, adapter, enabledTools });
        messageQueue.set(conversationId, queue);
        console.log(`[manager] Conversation ${conversationId} busy – queued message (${queue.length} waiting)`);
        await adapter.sendMessage(
          msg.externalChatId,
          `I'm still working on your previous request. Your message has been queued and will be processed next.`,
        );
        return;
      }

      conversationProcessing.add(conversationId);
      try {
        await handleConversationMessage(conversationId, msg, adapter, enabledTools);
      } finally {
        // Process any messages that arrived while we were busy
        await drainMessageQueue(conversationId);
        conversationProcessing.delete(conversationId);
      }
    })();
  });

  // Forward status changes
  adapter.on('status', (statusUpdate: { channelId: string; status: string; error?: string }) => {
    updateChannelStatus(statusUpdate.channelId, statusUpdate.status);
    channelManagerEvents.emit('channel:status', statusUpdate);
  });

  // Forward WhatsApp QR codes (convert raw string to data URL)
  adapter.on('qr', (qr: string) => {
    void (async () => {
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
    })();
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

/**
 * Process a single conversation message through the agent loop.
 */
async function handleConversationMessage(
  conversationId: string,
  msg: IncomingMessage,
  adapter: ChannelAdapter,
  enabledTools?: string[],
): Promise<void> {
  try {
    const agentConfig = resolveAgentConfig(msg.channelId, getSystemPrompt());

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
}

/**
 * Drain the message queue for a conversation after the current run completes.
 * All queued messages are merged into a single combined message so the agent
 * sees the full context without triggering multiple independent runs.
 */
async function drainMessageQueue(conversationId: string): Promise<void> {
  const queue = messageQueue.get(conversationId);
  if (!queue || queue.length === 0) {
    messageQueue.delete(conversationId);
    return;
  }

  // Take all queued messages at once and clear the queue
  const pending = [...queue];
  queue.length = 0;

  // Use the last message's adapter/tools (most recent context)
  const last = pending[pending.length - 1]!;

  // Merge all queued messages into one so the agent processes them as a batch
  const combinedText =
    pending.length === 1
      ? pending[0]!.msg.text
      : pending.map((q, i) => `[Message ${i + 1}]: ${q.msg.text}`).join('\n\n');

  const mergedMsg: IncomingMessage = {
    ...last.msg,
    text: combinedText,
  };

  console.log(`[manager] Draining ${pending.length} queued message(s) for conversation ${conversationId}`);

  try {
    await handleConversationMessage(conversationId, mergedMsg, last.adapter, last.enabledTools);
  } finally {
    // Recursively drain in case new messages arrived during processing
    await drainMessageQueue(conversationId);
  }
}
