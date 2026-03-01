/**
 * Auto-Skill-Discovery Manager
 *
 * Coordinates the auto-discovery lifecycle:
 * 1. Agent detects it needs a skill that isn't loaded → calls suggest_skill tool
 * 2. Discovery manager creates a HITL approval request
 * 3. Human approves/rejects via dashboard or channel
 * 4. If approved: skill is installed from catalog and live-loaded into the registry
 * 5. Agent receives confirmation and can now use the new tool
 */

import { EventEmitter } from 'events';
import { getCatalogEntry, getAvailableCatalogEntries, CatalogEntry } from './catalog';
import { installSkill, getAllSkills } from './loader';
import { toolRegistry } from '../tools/registry';
import { AgentTool } from '../tools/types';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../config';

export const discoveryEvents = new EventEmitter();
discoveryEvents.setMaxListeners(50);

/** Pending discovery requests awaiting human approval */
const pendingDiscoveries = new Map<
  string,
  {
    catalogEntry: CatalogEntry;
    reason: string;
    conversationId: string;
    resolve: (result: DiscoveryResult) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

export interface DiscoveryResult {
  approved: boolean;
  skillName: string;
  reason?: string;
  respondedBy?: string;
  setupHint?: string;
}

export interface DiscoveryRequest {
  id: string;
  skillName: string;
  displayName: string;
  description: string;
  reason: string;
  conversationId: string;
  requiredEnvVars?: string[];
  setupHint?: string;
  status: 'pending' | 'approved' | 'rejected' | 'timeout';
  createdAt: string;
}

/** Default timeout for discovery approval (5 minutes) */
const DISCOVERY_TIMEOUT_MS = 5 * 60 * 1000;

let discoveryIdCounter = 0;

function generateDiscoveryId(): string {
  discoveryIdCounter++;
  return `disc_${Date.now()}_${discoveryIdCounter}`;
}

/**
 * Request activation of a skill from the catalog.
 * Creates a HITL-style approval request and waits for human response.
 *
 * @returns Promise that resolves when human approves/rejects or timeout occurs
 */
export function requestSkillActivation(
  skillName: string,
  reason: string,
  conversationId: string,
): { discoveryId: string; promise: Promise<DiscoveryResult> } {
  const catalogEntry = getCatalogEntry(skillName);
  if (!catalogEntry) {
    // Skill not in catalog - return immediate rejection
    const id = generateDiscoveryId();
    return {
      discoveryId: id,
      promise: Promise.resolve({
        approved: false,
        skillName,
        reason: `Skill "${skillName}" is not available in the skill catalog.`,
      }),
    };
  }

  // Check if already installed
  const installed = getAllSkills().map((s) => s.name);
  if (installed.includes(skillName)) {
    const id = generateDiscoveryId();
    return {
      discoveryId: id,
      promise: Promise.resolve({
        approved: false,
        skillName,
        reason: `Skill "${skillName}" is already installed. It may be disabled - try toggling it on.`,
      }),
    };
  }

  const id = generateDiscoveryId();

  const request: DiscoveryRequest = {
    id,
    skillName: catalogEntry.name,
    displayName: catalogEntry.displayName,
    description: catalogEntry.description,
    reason,
    conversationId,
    requiredEnvVars: catalogEntry.requiredEnvVars,
    setupHint: catalogEntry.setupHint,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  // Emit event for WebSocket broadcast to dashboard
  discoveryEvents.emit('discovery:requested', request);

  const promise = new Promise<DiscoveryResult>((resolve) => {
    const timeout = setTimeout(() => {
      pendingDiscoveries.delete(id);

      discoveryEvents.emit('discovery:timeout', { ...request, status: 'timeout' });

      resolve({
        approved: false,
        skillName,
        reason: 'Skill activation request timed out. The user did not respond in time.',
      });
    }, DISCOVERY_TIMEOUT_MS);

    pendingDiscoveries.set(id, {
      catalogEntry,
      reason,
      conversationId,
      resolve,
      timeout,
    });
  });

  return { discoveryId: id, promise };
}

/**
 * Respond to a pending skill discovery request.
 * If approved, installs and live-loads the skill.
 */
export function respondToDiscovery(
  discoveryId: string,
  approved: boolean,
  respondedBy?: string,
  reason?: string,
): boolean {
  const pending = pendingDiscoveries.get(discoveryId);
  if (!pending) {
    return false;
  }

  clearTimeout(pending.timeout);
  pendingDiscoveries.delete(discoveryId);

  if (approved) {
    // Install the skill from catalog
    try {
      installSkill(pending.catalogEntry.manifest, pending.catalogEntry.handlerSource);

      // Live-load: re-scan and register the new skill
      const handlerPath = path.resolve(
        path.join(config.dataDir, 'skills', pending.catalogEntry.name),
        pending.catalogEntry.manifest.handler,
      );

      if (fs.existsSync(handlerPath)) {
        // Load handler and register directly for immediate availability
        try {
          // Clear require cache to ensure fresh load
          delete require.cache[require.resolve(handlerPath)];
          const handler = require(handlerPath);
          const execute = handler.execute || handler.default?.execute || handler;

          if (typeof execute === 'function' && !toolRegistry.get(pending.catalogEntry.name)) {
            const tool: AgentTool = {
              name: pending.catalogEntry.manifest.name,
              description: pending.catalogEntry.manifest.description,
              inputSchema: pending.catalogEntry.manifest.inputSchema as AgentTool['inputSchema'],
              execute,
            };
            toolRegistry.register(tool);
            console.log(`[discovery] Live-loaded skill: ${pending.catalogEntry.name}`);
          }
        } catch (loadErr) {
          console.warn(`[discovery] Could not live-load handler, will be available after restart:`, loadErr);
        }
      }

      discoveryEvents.emit('discovery:approved', {
        discoveryId,
        skillName: pending.catalogEntry.name,
        displayName: pending.catalogEntry.displayName,
        respondedBy,
      });

      pending.resolve({
        approved: true,
        skillName: pending.catalogEntry.name,
        respondedBy,
        setupHint: pending.catalogEntry.setupHint,
      });

      console.log(`[discovery] Skill "${pending.catalogEntry.name}" approved and installed by ${respondedBy || 'user'}`);
    } catch (installErr) {
      const errMsg = installErr instanceof Error ? installErr.message : String(installErr);
      console.error(`[discovery] Failed to install skill "${pending.catalogEntry.name}":`, errMsg);

      pending.resolve({
        approved: false,
        skillName: pending.catalogEntry.name,
        reason: `Installation failed: ${errMsg}`,
      });
    }
  } else {
    discoveryEvents.emit('discovery:rejected', {
      discoveryId,
      skillName: pending.catalogEntry.name,
      displayName: pending.catalogEntry.displayName,
      reason,
      respondedBy,
    });

    pending.resolve({
      approved: false,
      skillName: pending.catalogEntry.name,
      reason: reason || 'Skill activation was rejected by the user.',
      respondedBy,
    });

    console.log(`[discovery] Skill "${pending.catalogEntry.name}" rejected by ${respondedBy || 'user'}: ${reason || 'no reason'}`);
  }

  return true;
}

/**
 * Get all pending discovery requests.
 */
export function getPendingDiscoveries(): DiscoveryRequest[] {
  const result: DiscoveryRequest[] = [];
  for (const [id, pending] of pendingDiscoveries) {
    result.push({
      id,
      skillName: pending.catalogEntry.name,
      displayName: pending.catalogEntry.displayName,
      description: pending.catalogEntry.description,
      reason: pending.reason,
      conversationId: pending.conversationId,
      requiredEnvVars: pending.catalogEntry.requiredEnvVars,
      setupHint: pending.catalogEntry.setupHint,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  }
  return result;
}

/**
 * Get the count of pending discovery requests.
 */
export function getPendingDiscoveryCount(): number {
  return pendingDiscoveries.size;
}

/**
 * Build the catalog awareness section for the system prompt.
 * This tells the agent about skills it can suggest activating.
 */
export function buildCatalogPromptSection(): string {
  const installed = getAllSkills().map((s) => s.name);
  const available = getAvailableCatalogEntries(installed);

  if (available.length === 0) {
    return '';
  }

  const lines = [
    '\n\n## Available Skills (not yet activated)',
    'The following skills are available in the skill catalog but not currently active.',
    'If you need one of these capabilities to answer a user request, use the `suggest_skill` tool to request its activation.',
    'The user will be asked to approve the activation before the skill is loaded.\n',
  ];

  for (const entry of available) {
    const envNote = entry.requiredEnvVars?.length
      ? ` (requires: ${entry.requiredEnvVars.join(', ')})`
      : '';
    lines.push(`- **${entry.displayName}** (\`${entry.name}\`): ${entry.description}${envNote}`);
  }

  return lines.join('\n');
}
