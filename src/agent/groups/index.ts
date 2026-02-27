/**
 * Agent Groups module - manages agent groups and channel binding.
 */

export type {
  AgentGroup,
  AgentGroupRole,
  CreateAgentGroupInput,
  UpdateAgentGroupInput,
  AgentGroupStats,
} from './types';
export {
  initAgentGroupsSchema,
  createAgentGroup,
  getAgentGroup,
  getAllAgentGroups,
  updateAgentGroup,
  deleteAgentGroup,
  assignChannelToGroup,
  unassignChannelFromGroup,
  getGroupForChannel,
  getAgentGroupStats,
  getGroupTokenUsageToday,
  getGroupTokenUsageMonth,
  getGroupGithubToken,
} from './manager';
