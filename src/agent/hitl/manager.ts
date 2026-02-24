/**
 * HITL Approval Manager
 *
 * Coordinates the approval lifecycle:
 * 1. Agent calls a tool → manager checks if approval is needed
 * 2. If yes: creates approval request, emits event, waits for resolution
 * 3. Human approves/rejects via API or channel → manager resolves the promise
 * 4. Agent loop continues or aborts based on result
 */

import { EventEmitter } from 'events';
import {
  RiskLevel,
  ApprovalResponse,
  DEFAULT_TOOL_RISK,
  DEFAULT_TIMEOUT,
  DEFAULT_REQUIRE_APPROVAL,
} from './types';
import {
  createApprovalRequest,
  resolveApproval,
  getApprovalRequest,
  getApprovalRule,
  getPendingApprovals,
} from './db';

export const approvalEvents = new EventEmitter();
approvalEvents.setMaxListeners(100);

/** Map of pending approval ID → resolve/reject callbacks */
const pendingCallbacks = new Map<
  string,
  {
    resolve: (response: ApprovalResponse) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

/**
 * Check whether a tool call requires human approval.
 * Returns null if no approval is needed, or the resolved risk config if it does.
 */
export function checkApprovalRequired(
  toolName: string,
): { required: boolean; riskLevel: RiskLevel; timeoutSeconds: number; timeoutAction: 'reject' | 'approve' } {
  // Check for explicit rule first
  const rule = getApprovalRule(toolName);
  if (rule) {
    return {
      required: rule.requireApproval && !rule.autoApprove,
      riskLevel: rule.riskLevel,
      timeoutSeconds: rule.timeoutSeconds,
      timeoutAction: rule.timeoutAction,
    };
  }

  // Fall back to default risk level
  const riskLevel = DEFAULT_TOOL_RISK[toolName] || 'medium';
  const requireApproval = DEFAULT_REQUIRE_APPROVAL[riskLevel];

  return {
    required: requireApproval,
    riskLevel,
    timeoutSeconds: DEFAULT_TIMEOUT[riskLevel],
    timeoutAction: 'reject',
  };
}

/**
 * Request approval for a tool call. Returns a promise that resolves when
 * a human responds or the timeout expires.
 */
export function requestApproval(params: {
  runId: number;
  conversationId: string;
  channelId?: string;
  groupId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  riskLevel: RiskLevel;
  timeoutSeconds: number;
  timeoutAction: 'reject' | 'approve';
}): Promise<ApprovalResponse> {
  const approval = createApprovalRequest({
    runId: params.runId,
    conversationId: params.conversationId,
    channelId: params.channelId,
    groupId: params.groupId,
    toolName: params.toolName,
    toolInput: params.toolInput,
    riskLevel: params.riskLevel,
    timeoutSeconds: params.timeoutSeconds,
  });

  // Emit event for WebSocket broadcast and channel notifications
  approvalEvents.emit('approval:required', approval);

  return new Promise<ApprovalResponse>((resolve) => {
    const timeout = setTimeout(() => {
      pendingCallbacks.delete(approval.id);
      const action = params.timeoutAction;
      resolveApproval(approval.id, 'timeout', `Timed out after ${params.timeoutSeconds}s (auto-${action})`);

      approvalEvents.emit('approval:timeout', {
        ...approval,
        status: 'timeout',
        timeoutAction: action,
      });

      resolve({
        approved: action === 'approve',
        reason: `Approval timed out after ${params.timeoutSeconds}s — auto-${action}`,
      });
    }, params.timeoutSeconds * 1000);

    pendingCallbacks.set(approval.id, { resolve, timeout });
  });
}

/**
 * Respond to a pending approval request.
 * Called from the API endpoint or channel interaction.
 */
export function respondToApproval(
  approvalId: string,
  approved: boolean,
  reason?: string,
  respondedBy?: string,
): boolean {
  const pending = pendingCallbacks.get(approvalId);
  if (!pending) {
    // Check if it exists in DB but was already resolved
    const existing = getApprovalRequest(approvalId);
    if (!existing || existing.status !== 'pending') {
      return false;
    }
    // Edge case: request exists but callback was lost (server restart)
    // Just update DB status
    resolveApproval(approvalId, approved ? 'approved' : 'rejected', reason, respondedBy);
    return true;
  }

  clearTimeout(pending.timeout);
  pendingCallbacks.delete(approvalId);

  const status = approved ? 'approved' : 'rejected';
  resolveApproval(approvalId, status, reason, respondedBy);

  // Emit resolved event
  const approval = getApprovalRequest(approvalId);
  approvalEvents.emit('approval:resolved', {
    ...approval,
    status,
    reason,
    respondedBy,
  });

  // Unblock the agent loop
  pending.resolve({
    approved,
    reason,
    respondedBy,
  });

  return true;
}

/**
 * Expire stale pending approvals that have passed their timeout.
 * Called periodically as a cleanup task.
 */
export function expireStaleApprovals(): number {
  const pending = getPendingApprovals();
  const now = Date.now();
  let expired = 0;

  for (const approval of pending) {
    if (new Date(approval.timeoutAt).getTime() <= now) {
      const cb = pendingCallbacks.get(approval.id);
      if (cb) {
        clearTimeout(cb.timeout);
        pendingCallbacks.delete(approval.id);
        cb.resolve({ approved: false, reason: 'Expired during cleanup' });
      }
      resolveApproval(approval.id, 'timeout', 'Expired during cleanup');
      expired++;
    }
  }

  return expired;
}

/**
 * Get count of currently pending (in-memory) approvals.
 */
export function getPendingCount(): number {
  return pendingCallbacks.size;
}
