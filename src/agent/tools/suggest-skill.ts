/**
 * suggest_skill Tool - Agent self-awareness for missing capabilities.
 *
 * When the agent detects it needs a tool/skill that isn't currently loaded,
 * it can call this tool to request activation. The request goes through
 * HITL approval, and if approved, the skill is installed and live-loaded.
 *
 * Example flow:
 *   User: "Query my PostgreSQL database for all users"
 *   Agent: (recognizes no DB tool is available) → calls suggest_skill
 *   → HITL approval sent to user
 *   → User approves
 *   → postgresql_query skill is installed and loaded
 *   → Agent can now use the new tool
 */

import { AgentTool } from './types';
import { requestSkillActivation } from '../skills/discovery';
import { getCatalog, searchCatalog } from '../skills/catalog';
import { getAllSkills } from '../skills';

export const suggestSkillTool: AgentTool = {
  name: 'suggest_skill',
  description:
    'Suggest activating a skill from the catalog when you detect that you need a capability that is not currently available. ' +
    'Use this when a user request requires a tool you do not have (e.g., database access, Slack integration). ' +
    'The user will be asked to approve the activation. If approved, the skill is immediately loaded and available for use. ' +
    'Use action "search" to find matching skills, or "activate" to request activation of a specific skill.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        description: 'Action: "search" to find available skills by query, "activate" to request activation of a specific skill, "list" to see all available catalog skills',
        enum: ['search', 'activate', 'list'],
      },
      skill_name: {
        type: 'string',
        description: 'The skill name to activate (for "activate" action, e.g. "postgresql_query")',
      },
      query: {
        type: 'string',
        description: 'Search query to find matching skills (for "search" action, e.g. "database" or "messaging")',
      },
      reason: {
        type: 'string',
        description: 'Why you need this skill - explain what the user asked for and why this skill is required',
      },
      conversation_id: {
        type: 'string',
        description: 'Current conversation ID (passed automatically by the system)',
      },
    },
    required: ['action'],
  },
  execute: async (input: Record<string, unknown>) => {
    const action = input.action as string;
    const installedNames = getAllSkills().map((s) => s.name);

    switch (action) {
      case 'list': {
        const catalog = getCatalog();
        const entries = catalog.map((e) => ({
          name: e.name,
          displayName: e.displayName,
          description: e.description,
          tags: e.tags,
          installed: installedNames.includes(e.name),
          requiredEnvVars: e.requiredEnvVars,
        }));
        return {
          content: JSON.stringify(
            {
              availableSkills: entries.filter((e) => !e.installed),
              installedFromCatalog: entries.filter((e) => e.installed),
            },
            null,
            2,
          ),
        };
      }

      case 'search': {
        const query = (input.query as string) || '';
        if (!query) {
          return { content: 'Error: "query" is required for search action.', isError: true };
        }
        const results = searchCatalog(query, installedNames);
        if (results.length === 0) {
          return {
            content: `No matching skills found in the catalog for "${query}". Available skills: ${getCatalog().filter((e) => !installedNames.includes(e.name)).map((e) => e.name).join(', ') || 'none'}`,
          };
        }
        return {
          content: JSON.stringify(
            results.map((e) => ({
              name: e.name,
              displayName: e.displayName,
              description: e.description,
              tags: e.tags,
              requiredEnvVars: e.requiredEnvVars,
              setupHint: e.setupHint,
            })),
            null,
            2,
          ),
        };
      }

      case 'activate': {
        const skillName = input.skill_name as string;
        const reason = (input.reason as string) || 'Agent requested skill activation';
        const conversationId = (input.conversation_id as string) || '';

        if (!skillName) {
          return { content: 'Error: "skill_name" is required for activate action.', isError: true };
        }

        console.log(`[discovery] Agent requesting activation of "${skillName}": ${reason}`);

        const { promise } = requestSkillActivation(skillName, reason, conversationId);

        // Wait for human approval
        const result = await promise;

        if (result.approved) {
          let response = `Skill "${result.skillName}" has been activated and is now available for use.`;
          if (result.setupHint) {
            response += `\n\nSetup note: ${result.setupHint}`;
          }
          return { content: response };
        } else {
          return {
            content: `Skill activation was not approved: ${result.reason || 'No reason given'}. Please inform the user and suggest alternative approaches.`,
            isError: true,
          };
        }
      }

      default:
        return { content: `Unknown action: "${action}". Use "search", "activate", or "list".`, isError: true };
    }
  },
};
