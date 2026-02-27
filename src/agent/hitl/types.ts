/**
 * Human-in-the-Loop (HITL) Approval System Types
 *
 * Risk-based tool approval gates that pause agent execution
 * and wait for human review before proceeding.
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout' | 'auto_approved';

export interface ApprovalRequest {
  id: string;
  runId: number;
  conversationId: string;
  channelId?: string;
  groupId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  riskLevel: RiskLevel;
  status: ApprovalStatus;
  reason?: string;
  respondedBy?: string;
  requestedAt: string;
  respondedAt?: string;
  timeoutAt: string;
  expiresAt: string;
}

export interface ApprovalRule {
  id: string;
  toolName: string;
  riskLevel: RiskLevel;
  autoApprove: boolean;
  requireApproval: boolean;
  timeoutSeconds: number;
  timeoutAction: 'reject' | 'approve';
  enabled: boolean;
}

export interface ApprovalResponse {
  approved: boolean;
  reason?: string;
  respondedBy?: string;
}

/** Default risk levels for built-in tools */
export const DEFAULT_TOOL_RISK: Record<string, RiskLevel> = {
  web_browse: 'low',
  http_request: 'medium',
  run_script: 'high',
  delegate_task: 'medium',
  broadcast_event: 'low',
  query_agents: 'low',
  git_clone: 'medium',
  git_read_file: 'low',
  git_write_file: 'medium',
  git_commit_push: 'high',
};

/** Default timeout in seconds per risk level */
export const DEFAULT_TIMEOUT: Record<RiskLevel, number> = {
  low: 0,        // auto-approve, no wait
  medium: 0,     // auto-approve by default
  high: 300,     // 5 minutes
  critical: 600, // 10 minutes
};

/** Whether each risk level requires approval by default */
export const DEFAULT_REQUIRE_APPROVAL: Record<RiskLevel, boolean> = {
  low: false,
  medium: false,
  high: true,
  critical: true,
};
