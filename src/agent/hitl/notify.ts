/**
 * HITL Approval Notification Routing
 *
 * When an approval is needed, sends a notification to the user
 * via their active messaging channel (Telegram, WhatsApp, Email).
 */

import { ApprovalRequest } from './types';
import { getChannelAdapter } from '../../channels/manager';
import { getDb } from '../../db/sqlite';

/**
 * Send an approval notification to the user via the channel
 * associated with the conversation that triggered the tool call.
 */
export async function notifyApprovalRequired(approval: ApprovalRequest): Promise<void> {
  // Find which channel this conversation belongs to
  const channelId = approval.channelId || findChannelForConversation(approval.conversationId);
  if (!channelId) {
    console.log(`[hitl] No channel found for conversation ${approval.conversationId}, skipping notification`);
    return;
  }

  const adapter = getChannelAdapter(channelId);
  if (!adapter) {
    console.log(`[hitl] No active adapter for channel ${channelId}, skipping notification`);
    return;
  }

  // Find the external chat ID for this conversation
  const externalChatId = findExternalChatId(approval.conversationId);
  if (!externalChatId) {
    console.log(`[hitl] No external chat ID for conversation ${approval.conversationId}`);
    return;
  }

  const inputPreview = JSON.stringify(approval.toolInput).slice(0, 300);
  const timeoutSec = Math.round(
    (new Date(approval.timeoutAt).getTime() - Date.now()) / 1000,
  );

  const message = [
    `\u26a0\ufe0f *Approval Required*`,
    ``,
    `Tool: \`${approval.toolName}\``,
    `Risk: ${approval.riskLevel.toUpperCase()}`,
    `Input: \`${inputPreview}\``,
    ``,
    `Timeout: ${timeoutSec}s`,
    `ID: \`${approval.id}\``,
    ``,
    `Reply with:`,
    `  \`/approve ${approval.id}\` to approve`,
    `  \`/reject ${approval.id} [reason]\` to reject`,
  ].join('\n');

  try {
    await adapter.sendMessage(externalChatId, message);
  } catch (err) {
    console.error(`[hitl] Failed to send approval notification:`, err);
  }
}

/**
 * Send a notification that an approval was resolved.
 */
export async function notifyApprovalResolved(
  approval: ApprovalRequest & { respondedBy?: string },
): Promise<void> {
  const channelId = approval.channelId || findChannelForConversation(approval.conversationId);
  if (!channelId) return;

  const adapter = getChannelAdapter(channelId);
  if (!adapter) return;

  const externalChatId = findExternalChatId(approval.conversationId);
  if (!externalChatId) return;

  const emoji = approval.status === 'approved' ? '\u2705' : '\u274c';
  const message = [
    `${emoji} Tool \`${approval.toolName}\` — ${approval.status}`,
    approval.reason ? `Reason: ${approval.reason}` : '',
    approval.respondedBy ? `By: ${approval.respondedBy}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    await adapter.sendMessage(externalChatId, message);
  } catch (err) {
    console.error(`[hitl] Failed to send resolution notification:`, err);
  }
}

function findChannelForConversation(conversationId: string): string | undefined {
  const row = getDb()
    .prepare('SELECT channel_id FROM conversations WHERE id = ?')
    .get(conversationId) as { channel_id: string } | undefined;
  return row?.channel_id;
}

function findExternalChatId(conversationId: string): string | undefined {
  const row = getDb()
    .prepare('SELECT external_id FROM conversations WHERE id = ?')
    .get(conversationId) as { external_id: string } | undefined;
  return row?.external_id;
}
