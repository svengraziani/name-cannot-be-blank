export { initHitlSchema } from './db';
export { notifyApprovalRequired, notifyApprovalResolved } from './notify';
export {
  createApprovalRequest,
  resolveApproval,
  getApprovalRequest,
  getPendingApprovals,
  getApprovalsByRun,
  getRecentApprovals,
  getApprovalStats,
  getApprovalRule,
  getAllApprovalRules,
  upsertApprovalRule,
  deleteApprovalRule,
} from './db';
export {
  approvalEvents,
  checkApprovalRequired,
  requestApproval,
  respondToApproval,
  expireStaleApprovals,
  getPendingCount,
} from './manager';
export type {
  RiskLevel,
  ApprovalStatus,
  ApprovalRequest,
  ApprovalRule,
  ApprovalResponse,
} from './types';
export { DEFAULT_TOOL_RISK, DEFAULT_TIMEOUT, DEFAULT_REQUIRE_APPROVAL } from './types';
