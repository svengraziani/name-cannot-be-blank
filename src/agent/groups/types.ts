/**
 * Agent Group Types - Data models for agent groups and channel binding.
 */

export interface AgentGroup {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;

  // AI settings (configurable per group via UI)
  apiKeyEncrypted?: string | null; // AES-256 encrypted, null = use global key
  model: string;
  maxTokens: number;

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
  budgetMaxTokensDay?: number;
  budgetMaxTokensMonth?: number;
  budgetAlertThreshold?: number;
  skills?: string[];
  roles?: AgentGroupRole[];
  containerMode?: boolean;
  maxConcurrentAgents?: number;
}

export interface UpdateAgentGroupInput {
  name?: string;
  description?: string;
  systemPrompt?: string;
  apiKey?: string | null; // null = clear, use global
  model?: string;
  maxTokens?: number;
  budgetMaxTokensDay?: number;
  budgetMaxTokensMonth?: number;
  budgetAlertThreshold?: number;
  skills?: string[];
  roles?: AgentGroupRole[];
  containerMode?: boolean;
  maxConcurrentAgents?: number;
}

export interface AgentGroupStats {
  groupId: string;
  todayTokens: number;
  monthTokens: number;
  activeAgents: number;
  totalRuns: number;
}
