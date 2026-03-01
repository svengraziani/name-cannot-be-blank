/**
 * Edge Deployment – Lightweight mode for resource-constrained environments.
 *
 * Run Loop Gateway on a Raspberry Pi, VPS with 1GB RAM, or IoT/kiosk systems.
 * SQLite is already lightweight by default. This module adds:
 *
 * - Haiku-only mode (cheapest, fastest model)
 * - Skills disabled (reduces memory footprint)
 * - No container isolation (avoids Docker overhead)
 * - Reduced conversation history depth
 * - Disabled file watchers
 * - Minimal logging
 *
 * Enable via: EDGE_MODE=true in .env
 */

export interface EdgeConfig {
  enabled: boolean;
  /** Force all requests to use Haiku regardless of group config */
  haikuOnly: boolean;
  /** Disable all skills (built-in tools still work) */
  disableSkills: boolean;
  /** Disable container isolation */
  disableContainers: boolean;
  /** Max conversation history messages to load (lower = less memory) */
  maxHistoryMessages: number;
  /** Disable file watchers for skill hot-reload */
  disableFileWatchers: boolean;
  /** Max tokens per response (lower for edge) */
  maxTokens: number;
  /** Max concurrent requests (limit for low-RAM environments) */
  maxConcurrentRequests: number;
}

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

export function loadEdgeConfig(): EdgeConfig {
  const enabled = process.env.EDGE_MODE === 'true';

  if (!enabled) {
    return {
      enabled: false,
      haikuOnly: false,
      disableSkills: false,
      disableContainers: false,
      maxHistoryMessages: 20,
      disableFileWatchers: false,
      maxTokens: 16384,
      maxConcurrentRequests: 10,
    };
  }

  return {
    enabled: true,
    haikuOnly: process.env.EDGE_HAIKU_ONLY !== 'false', // default true in edge mode
    disableSkills: process.env.EDGE_DISABLE_SKILLS !== 'false', // default true
    disableContainers: true, // always disable in edge mode
    maxHistoryMessages: parseInt(process.env.EDGE_MAX_HISTORY || '8', 10),
    disableFileWatchers: true, // always disable in edge mode
    maxTokens: parseInt(process.env.EDGE_MAX_TOKENS || '4096', 10),
    maxConcurrentRequests: parseInt(process.env.EDGE_MAX_CONCURRENT || '2', 10),
  };
}

// Singleton edge config loaded at startup
let edgeConfig: EdgeConfig | null = null;

export function getEdgeConfig(): EdgeConfig {
  if (!edgeConfig) {
    edgeConfig = loadEdgeConfig();
  }
  return edgeConfig;
}

/**
 * Apply edge constraints to model selection.
 * In haiku-only mode, always returns the Haiku model.
 */
export function applyEdgeModel(requestedModel: string): string {
  const cfg = getEdgeConfig();
  if (cfg.enabled && cfg.haikuOnly) {
    return HAIKU_MODEL;
  }
  return requestedModel;
}

/**
 * Apply edge constraints to max tokens.
 */
export function applyEdgeMaxTokens(requestedMaxTokens: number): number {
  const cfg = getEdgeConfig();
  if (cfg.enabled) {
    return Math.min(requestedMaxTokens, cfg.maxTokens);
  }
  return requestedMaxTokens;
}

/**
 * Apply edge constraints to history depth.
 */
export function applyEdgeHistoryLimit(requestedLimit: number): number {
  const cfg = getEdgeConfig();
  if (cfg.enabled) {
    return Math.min(requestedLimit, cfg.maxHistoryMessages);
  }
  return requestedLimit;
}

// Concurrency limiter for edge mode
let activeRequests = 0;

export function canAcceptRequest(): boolean {
  const cfg = getEdgeConfig();
  if (!cfg.enabled) return true;
  return activeRequests < cfg.maxConcurrentRequests;
}

export function acquireRequest(): boolean {
  if (!canAcceptRequest()) return false;
  activeRequests++;
  return true;
}

export function releaseRequest(): void {
  activeRequests = Math.max(0, activeRequests - 1);
}

/**
 * Log edge mode status at startup.
 */
export function logEdgeStatus(): void {
  const cfg = getEdgeConfig();
  if (!cfg.enabled) return;

  console.log('[edge] ======================================');
  console.log('[edge]   Edge Deployment Mode: ACTIVE');
  console.log('[edge] ======================================');
  console.log(`[edge] Haiku-only: ${cfg.haikuOnly}`);
  console.log(`[edge] Skills disabled: ${cfg.disableSkills}`);
  console.log(`[edge] Containers disabled: ${cfg.disableContainers}`);
  console.log(`[edge] Max history: ${cfg.maxHistoryMessages} messages`);
  console.log(`[edge] Max tokens: ${cfg.maxTokens}`);
  console.log(`[edge] Max concurrent: ${cfg.maxConcurrentRequests}`);
  console.log('[edge] ======================================');
}
