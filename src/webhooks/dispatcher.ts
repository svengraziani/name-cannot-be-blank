/**
 * Webhook Dispatcher - Sends events to registered outbound webhooks.
 *
 * When an event fires (e.g. agent run completed), this module finds all
 * webhooks subscribed to that event and POSTs the payload to their target URLs.
 */

import { EventEmitter } from 'events';
import { getWebhooksByEvent, recordWebhookTrigger, logWebhookDelivery } from './db';

export const webhookEvents = new EventEmitter();

/**
 * Dispatch an event to all registered outbound webhooks that subscribe to it.
 */
export async function dispatchWebhookEvent(
  event: string,
  payload: Record<string, unknown>,
  groupId?: string,
): Promise<void> {
  let webhooks = getWebhooksByEvent(event);

  // Scope to group if provided
  if (groupId) {
    webhooks = webhooks.filter((w) => !w.agentGroupId || w.agentGroupId === groupId);
  }

  if (webhooks.length === 0) return;

  const body = {
    event,
    payload,
    timestamp: new Date().toISOString(),
    source: 'loop-gateway',
  };

  const deliveries = webhooks
    .filter((w) => w.targetUrl)
    .map(async (webhook) => {
      try {
        const response = await fetch(webhook.targetUrl!, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Event': event,
            'X-Webhook-Id': webhook.id,
            'X-Webhook-Token': webhook.token,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });

        recordWebhookTrigger(webhook.id);
        logWebhookDelivery({
          webhookId: webhook.id,
          event,
          payload: JSON.stringify(body),
          status: response.ok ? 'delivered' : 'failed',
          responseStatus: response.status,
        });

        if (!response.ok) {
          console.warn(`[webhooks] Delivery to ${webhook.name} failed: HTTP ${response.status}`);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logWebhookDelivery({
          webhookId: webhook.id,
          event,
          payload: JSON.stringify(body),
          status: 'error',
          error: errorMsg,
        });
        console.error(`[webhooks] Delivery to ${webhook.name} error: ${errorMsg}`);
      }
    });

  await Promise.allSettled(deliveries);
}
