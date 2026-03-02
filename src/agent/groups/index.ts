/**
 * Agent Groups module - manages agent groups and channel binding.
 */

export type {
  AgentGroup,
  AgentGroupRole,
  CreateAgentGroupInput,
  UpdateAgentGroupInput,
  AgentGroupStats,
  PersonaConfig,
  EmojiUsage,
  PersonaLanguage,
} from './types';
export { DEFAULT_PERSONA } from './types';
export { detectLanguage, resolveLanguage, buildPersonaPrompt, synthesizeSpeech } from './persona';
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
