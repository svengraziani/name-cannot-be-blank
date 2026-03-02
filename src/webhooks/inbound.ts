/**
 * Inbound Webhook Handler - Accepts incoming requests from n8n, Make.com, and generic platforms
 * to trigger agent runs, create tasks, or send messages.
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getWebhookByToken } from './db';
import { getOrCreateConversation } from '../db/sqlite';
import { processMessage } from '../agent/loop';
import { getAgentGroup, getGroupGithubToken } from '../agent/groups';
import { getGroupApiKey } from '../agent/groups/manager';
import { ResolvedAgentConfig } from '../agent/groups/resolver';
import { createAndStartTask } from '../agent/loop-mode';
import { InboundWebhookPayload, InboundWebhookResponse } from './types';

/**
 * Build a ResolvedAgentConfig from a group ID for webhook-triggered runs.
 */
function resolveGroupConfig(groupId: string): ResolvedAgentConfig | undefined {
  const group = getAgentGroup(groupId);
  if (!group) return undefined;

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
  };
}

export function createWebhookRouter(): Router {
  const router = Router();

  /**
   * POST /webhook/invoke/:token
   *
   * Universal inbound webhook — triggers an agent run.
   * Works with n8n HTTP Request node, Make.com HTTP module, or any platform.
   *
   * Body: { message, agentGroupId?, conversationId?, sync?, metadata? }
   */
  router.post('/invoke/:token', async (req: Request, res: Response) => {
    try {
      const webhook = getWebhookByToken(req.params.token as string);
      if (!webhook || !webhook.enabled) {
        res.status(401).json({ success: false, error: 'Invalid or disabled webhook token' });
        return;
      }

      const body = req.body as InboundWebhookPayload;
      if (!body.message) {
        res.status(400).json({ success: false, error: 'message is required' });
        return;
      }

      const groupId = body.agentGroupId || webhook.agentGroupId;
      const agentConfig = groupId ? resolveGroupConfig(groupId) : undefined;

      // Create or reuse a conversation for this webhook
      const channelId = `webhook-${webhook.id}`;
      const externalId = body.conversationId || `wh-${uuidv4()}`;
      const conversationId = getOrCreateConversation(channelId, externalId, `Webhook: ${webhook.name}`);

      if (body.sync === false) {
        // Async mode: fire and forget
        void processMessage(conversationId, body.message, 'webhook', `webhook:${webhook.platform}`, undefined, agentConfig);

        const response: InboundWebhookResponse = {
          success: true,
          conversationId,
          metadata: body.metadata,
        };
        res.json(response);
        return;
      }

      // Sync mode (default): wait for agent response
      const result = await processMessage(
        conversationId,
        body.message,
        'webhook',
        `webhook:${webhook.platform}`,
        undefined,
        agentConfig,
      );

      const response: InboundWebhookResponse = {
        success: true,
        response: result,
        conversationId,
        metadata: body.metadata,
      };
      res.json(response);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[webhook:inbound] Error:', errorMsg);
      res.status(500).json({ success: false, error: errorMsg });
    }
  });

  /**
   * POST /webhook/task/:token
   *
   * Creates and starts a loop task via webhook.
   * Useful for n8n/Make.com to kick off autonomous multi-step agent tasks.
   *
   * Body: { name, prompt, maxIterations? }
   */
  router.post('/task/:token', (req: Request, res: Response) => {
    try {
      const webhook = getWebhookByToken(req.params.token as string);
      if (!webhook || !webhook.enabled) {
        res.status(401).json({ success: false, error: 'Invalid or disabled webhook token' });
        return;
      }

      const { name, prompt, maxIterations } = req.body;
      if (!name || !prompt) {
        res.status(400).json({ success: false, error: 'name and prompt are required' });
        return;
      }

      const taskId = createAndStartTask({
        name,
        promptContent: prompt,
        maxIterations: maxIterations || 10,
      });

      res.json({ success: true, taskId, status: 'started' });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[webhook:task] Error:', errorMsg);
      res.status(500).json({ success: false, error: errorMsg });
    }
  });

  /**
   * GET /webhook/health/:token
   *
   * Health check endpoint for webhook validation.
   * n8n and Make.com use this to verify the webhook URL is reachable.
   */
  router.get('/health/:token', (req: Request, res: Response) => {
    const webhook = getWebhookByToken(req.params.token as string);
    if (!webhook || !webhook.enabled) {
      res.status(401).json({ success: false, error: 'Invalid or disabled webhook token' });
      return;
    }

    res.json({
      success: true,
      webhook: {
        id: webhook.id,
        name: webhook.name,
        platform: webhook.platform,
        events: webhook.events,
      },
    });
  });

  return router;
}
