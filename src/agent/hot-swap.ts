/**
 * Hot-Swap Models – Switch models mid-conversation without losing context.
 *
 * Starts with a fast/cheap model (Haiku) for simple queries, automatically
 * escalates to a more capable model (Opus) when complexity is detected.
 * Token-optimized AND quality-optimized.
 *
 * Complexity signals:
 * - Message length (long messages = likely complex)
 * - Code blocks, technical keywords
 * - Multi-step reasoning indicators
 * - Conversation depth (many back-and-forth turns)
 * - Explicit escalation phrases ("explain in detail", "step by step", etc.)
 * - Previous assistant response was truncated or insufficient
 */

export interface HotSwapConfig {
  enabled: boolean;
  /** Model tiers ordered from fastest/cheapest to most capable */
  tiers: ModelTier[];
  /** Complexity threshold (0-100) to escalate from one tier to the next */
  escalationThreshold: number;
  /** If true, allow de-escalation back to cheaper models for simple follow-ups */
  deescalation: boolean;
}

export interface ModelTier {
  model: string;
  /** Max complexity score this tier handles (0-100). Messages above this score escalate. */
  maxComplexity: number;
  /** Label for logging/UI */
  label: string;
}

export const DEFAULT_HOT_SWAP_CONFIG: HotSwapConfig = {
  enabled: false,
  tiers: [
    { model: 'claude-haiku-4-5-20251001', maxComplexity: 40, label: 'Haiku (fast)' },
    { model: 'claude-sonnet-4-20250514', maxComplexity: 75, label: 'Sonnet (balanced)' },
    { model: 'claude-opus-4-20250514', maxComplexity: 100, label: 'Opus (max quality)' },
  ],
  escalationThreshold: 40,
  deescalation: true,
};

// Keywords/patterns that indicate higher complexity
const COMPLEXITY_PATTERNS = {
  codeBlock: /```[\s\S]{20,}```/,
  technicalTerms:
    /\b(algorithm|architecture|refactor|optimize|debug|implement|database|schema|migration|deploy|kubernetes|docker|microservice|authentication|encryption|concurrency|async|parallel|distributed|machine learning|neural|regression|statistical)\b/i,
  multiStep:
    /\b(step by step|first.*then|1\).*2\)|phase \d|sequentially|in order|walkthrough|breakdown|analyze.*and.*then)\b/i,
  detailRequest:
    /\b(explain in detail|elaborate|comprehensive|thorough|in-depth|deep dive|full analysis|complete overview|tell me everything)\b/i,
  comparison:
    /\b(compare|contrast|pros and cons|trade-?offs?|advantages|disadvantages|versus|vs\.?)\b/i,
  codeGeneration:
    /\b(write a? ?(function|class|module|script|program|api|endpoint|component|service)|generate code|create a? ?(file|implementation|solution))\b/i,
  math: /\b(calculate|equation|formula|integral|derivative|probability|statistics|matrix|linear algebra)\b/i,
};

/**
 * Compute a complexity score (0-100) for a user message.
 */
export function computeComplexity(
  message: string,
  conversationLength: number,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // Message length (longer = more complex)
  if (message.length > 2000) {
    score += 25;
    reasons.push('long message');
  } else if (message.length > 500) {
    score += 15;
    reasons.push('medium message');
  } else if (message.length > 200) {
    score += 5;
  }

  // Pattern matching
  for (const [name, pattern] of Object.entries(COMPLEXITY_PATTERNS)) {
    if (pattern.test(message)) {
      score += 15;
      reasons.push(name);
    }
  }

  // Conversation depth (more turns = likely building on complex topic)
  if (conversationLength > 10) {
    score += 15;
    reasons.push('deep conversation');
  } else if (conversationLength > 5) {
    score += 8;
    reasons.push('ongoing conversation');
  }

  // Question marks and complexity of question structure
  const questionMarks = (message.match(/\?/g) || []).length;
  if (questionMarks > 3) {
    score += 10;
    reasons.push('multiple questions');
  }

  // Word count
  const wordCount = message.split(/\s+/).length;
  if (wordCount > 200) {
    score += 10;
    reasons.push('high word count');
  }

  // Cap at 100
  return { score: Math.min(score, 100), reasons };
}

/**
 * Select the appropriate model tier based on complexity score.
 */
export function selectModelForComplexity(
  complexityScore: number,
  hotSwapConfig: HotSwapConfig,
): ModelTier {
  // Find the cheapest tier that can handle this complexity
  const sorted = [...hotSwapConfig.tiers].sort((a, b) => a.maxComplexity - b.maxComplexity);
  for (const tier of sorted) {
    if (complexityScore <= tier.maxComplexity) {
      return tier;
    }
  }
  // If nothing matches, use the most capable tier
  return sorted[sorted.length - 1]!;
}

// Track which model was last used per conversation (for de-escalation logic)
const conversationModelHistory = new Map<string, string>();

/**
 * Resolve the effective model for a message in a conversation.
 * Returns the model to use and metadata about the decision.
 */
export function resolveHotSwapModel(
  conversationId: string,
  message: string,
  conversationLength: number,
  hotSwapConfig: HotSwapConfig,
  baseModel: string,
): { model: string; tier: ModelTier | null; complexity: { score: number; reasons: string[] }; swapped: boolean } {
  if (!hotSwapConfig.enabled || hotSwapConfig.tiers.length === 0) {
    return { model: baseModel, tier: null, complexity: { score: 0, reasons: [] }, swapped: false };
  }

  const complexity = computeComplexity(message, conversationLength);
  const selectedTier = selectModelForComplexity(complexity.score, hotSwapConfig);
  const previousModel = conversationModelHistory.get(conversationId);

  // De-escalation check: if we previously used a higher-tier model,
  // only de-escalate if the config allows it
  if (!hotSwapConfig.deescalation && previousModel) {
    const previousTier = hotSwapConfig.tiers.find((t) => t.model === previousModel);
    if (previousTier && previousTier.maxComplexity > selectedTier.maxComplexity) {
      // Stick with the previous (more capable) model
      conversationModelHistory.set(conversationId, previousModel);
      return {
        model: previousModel,
        tier: previousTier,
        complexity,
        swapped: false,
      };
    }
  }

  const swapped = previousModel !== undefined && previousModel !== selectedTier.model;
  conversationModelHistory.set(conversationId, selectedTier.model);

  return {
    model: selectedTier.model,
    tier: selectedTier,
    complexity,
    swapped,
  };
}

/**
 * Clear model history for a conversation (e.g., on conversation reset).
 */
export function clearHotSwapHistory(conversationId: string): void {
  conversationModelHistory.delete(conversationId);
}
