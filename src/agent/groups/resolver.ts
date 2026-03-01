/**
 * Group Resolver - Resolves agent configuration for a channel message.
 *
 * When a message comes in from a channel, the resolver determines:
 * - Which agent group (if any) is assigned to the channel
 * - What system prompt, model, API key, and skills to use
 * - Whether budget limits are exceeded
 */

import { config } from '../../config';
import type { PersonaConfig } from './types';
import {
  getGroupForChannel,
  getAgentGroup,
  getGroupApiKey,
  getGroupGithubToken,
  getGroupTokenUsageToday,
  getGroupTokenUsageMonth,
} from './manager';

export interface ResolvedAgentConfig {
  systemPrompt: string;
  model: string;
  maxTokens: number;
  apiKey: string;
  enabledSkills?: string[];
  groupId?: string;
  containerMode: boolean;
  githubRepo?: string;
  githubToken?: string;
  persona?: PersonaConfig;
}

/**
 * Resolve the agent configuration for a given channel.
 * If the channel has an agent group, use its settings.
 * Otherwise, fall back to global defaults.
 */
export function resolveAgentConfig(channelId: string, defaultSystemPrompt: string): ResolvedAgentConfig {
  const group = getGroupForChannel(channelId);

  if (!group) {
    // No group assigned - use global defaults
    return {
      systemPrompt: defaultSystemPrompt,
      model: config.agentModel,
      maxTokens: config.agentMaxTokens,
      apiKey: config.anthropicApiKey,
      containerMode: process.env.AGENT_CONTAINER_MODE === 'true',
    };
  }

  return {
    systemPrompt: group.systemPrompt,
    model: group.model,
    maxTokens: group.maxTokens,
    apiKey: getGroupApiKey(group.id),
    enabledSkills: group.skills.length > 0 ? group.skills : undefined,
    groupId: group.id,
    containerMode: group.containerMode,
    githubRepo: group.githubRepo || undefined,
    githubToken: getGroupGithubToken(group.id) || undefined,
    persona: group.persona,
  };
}

/**
 * Check if a group has exceeded its budget limits.
 * Returns null if OK, or an error message if budget exceeded.
 */
export function checkGroupBudget(groupId: string): string | null {
  const group = getAgentGroup(groupId);
  if (!group) return null;

  if (group.budgetMaxTokensDay > 0) {
    const todayUsage = getGroupTokenUsageToday(group.id);
    if (todayUsage >= group.budgetMaxTokensDay) {
      return `Daily token budget exceeded (${todayUsage}/${group.budgetMaxTokensDay})`;
    }
  }

  if (group.budgetMaxTokensMonth > 0) {
    const monthUsage = getGroupTokenUsageMonth(group.id);
    if (monthUsage >= group.budgetMaxTokensMonth) {
      return `Monthly token budget exceeded (${monthUsage}/${group.budgetMaxTokensMonth})`;
    }
  }

  return null;
}
