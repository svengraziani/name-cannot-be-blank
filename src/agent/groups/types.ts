/**
 * Agent Group Types - Data models for agent groups and channel binding.
 */

import type { HotSwapConfig } from '../hot-swap';
import type { FallbackChainConfig } from '../fallback-chain';

export interface AgentGroup {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;

  // AI settings (configurable per group via UI)
  apiKeyEncrypted?: string | null; // AES-256 encrypted, null = use global key
  model: string;
  maxTokens: number;

  // GitHub integration (for git_clone / git_commit_push tools)
  githubRepo: string; // e.g. "owner/repo"
  githubTokenEncrypted?: string | null; // PAT, AES-256 encrypted

  // Budget (per group, 0 = unlimited)
  budgetMaxTokensDay: number;
  budgetMaxTokensMonth: number;
  budgetAlertThreshold: number; // warn at X% (e.g. 80)

  // Skills this group may use
  skills: string[];

  // Roles active in this group
  roles: AgentGroupRole[];

  // Container mode settings
  containerMode: boolean;
  maxConcurrentAgents: number;

  // Hot-Swap Models config (per group)
  hotSwapConfig: HotSwapConfig;

  // Fallback Chain config (per group)
  fallbackChainConfig: FallbackChainConfig;

  createdAt: string;
  updatedAt: string;
}

export interface AgentGroupRole {
  role: string; // e.g. "planner", "builder", "reviewer", "researcher"
  systemPromptOverride?: string;
  skills: string[]; // additional skills only for this role
  autoSpawn: boolean;
}

export interface CreateAgentGroupInput {
  name: string;
  description?: string;
  systemPrompt: string;
  apiKey?: string; // plain text, will be encrypted before storage
  model?: string;
  maxTokens?: number;
  githubRepo?: string;
  githubToken?: string; // plain text PAT, will be encrypted before storage
  budgetMaxTokensDay?: number;
  budgetMaxTokensMonth?: number;
  budgetAlertThreshold?: number;
  skills?: string[];
  roles?: AgentGroupRole[];
  containerMode?: boolean;
  maxConcurrentAgents?: number;
  hotSwapConfig?: HotSwapConfig;
  fallbackChainConfig?: FallbackChainConfig;
}

export interface UpdateAgentGroupInput {
  name?: string;
  description?: string;
  systemPrompt?: string;
  apiKey?: string | null; // null = clear, use global
  model?: string;
  maxTokens?: number;
  githubRepo?: string;
  githubToken?: string | null; // null = clear, string = encrypt
  budgetMaxTokensDay?: number;
  budgetMaxTokensMonth?: number;
  budgetAlertThreshold?: number;
  skills?: string[];
  roles?: AgentGroupRole[];
  containerMode?: boolean;
  maxConcurrentAgents?: number;
  hotSwapConfig?: HotSwapConfig;
  fallbackChainConfig?: FallbackChainConfig;
}

export interface AgentGroupStats {
  groupId: string;
  todayTokens: number;
  monthTokens: number;
  activeAgents: number;
  totalRuns: number;
}
