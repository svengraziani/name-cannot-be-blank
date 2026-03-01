/**
 * Agent Group Types - Data models for agent groups and channel binding.
 */

export type EmojiUsage = 'none' | 'minimal' | 'moderate' | 'heavy';
export type PersonaLanguage = 'auto' | 'de' | 'en' | string;

export interface PersonaConfig {
  /** Freeform personality description (e.g. "Friendly Viennese food expert") */
  personality: string;

  /** Response style hint (e.g. "formal", "casual", "wienerisch", "poetic") */
  responseStyle: string;

  /** How liberally the agent should use emojis */
  emojiUsage: EmojiUsage;

  /**
   * Language preference.
   * "auto" = detect from user message and reply in the same language.
   * "de", "en", etc. = always reply in this language.
   */
  language: PersonaLanguage;

  /** Enable text-to-speech voice messages on supported channels (e.g. Telegram) */
  voiceEnabled: boolean;

  /** TTS voice speed multiplier (0.5 – 2.0, default 1.0) */
  voiceSpeed: number;
}

export const DEFAULT_PERSONA: PersonaConfig = {
  personality: '',
  responseStyle: '',
  emojiUsage: 'none',
  language: 'auto',
  voiceEnabled: false,
  voiceSpeed: 1.0,
};

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

  // Persona settings (personality, language, emoji, voice)
  persona: PersonaConfig;

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
  githubRepo?: string;
  githubToken?: string; // plain text PAT, will be encrypted before storage
  budgetMaxTokensDay?: number;
  budgetMaxTokensMonth?: number;
  budgetAlertThreshold?: number;
  skills?: string[];
  roles?: AgentGroupRole[];
  persona?: Partial<PersonaConfig>;
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
  githubRepo?: string;
  githubToken?: string | null; // null = clear, string = encrypt
  budgetMaxTokensDay?: number;
  budgetMaxTokensMonth?: number;
  budgetAlertThreshold?: number;
  skills?: string[];
  roles?: AgentGroupRole[];
  persona?: Partial<PersonaConfig>;
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
