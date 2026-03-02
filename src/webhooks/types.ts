/**
 * Webhook types for external automation platform integrations (n8n, Make.com, etc.)
 */

export interface WebhookRegistration {
  id: string;
  name: string;
  /** Token used for authentication on inbound/outbound calls */
  token: string;
  /** Events this webhook listens to (e.g. 'agent:run:complete', 'task:complete', '*') */
  events: string[];
  /** URL to POST events to (outbound webhooks) */
  targetUrl?: string;
  /** Platform hint: 'n8n' | 'make' | 'generic' */
  platform: string;
  /** Associated agent group (optional - scopes webhook to group events) */
  agentGroupId?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastTriggeredAt?: string;
  triggerCount: number;
}

export interface WebhookEvent {
  webhookId: string;
  event: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface InboundWebhookPayload {
  /** Message to send to the agent */
  message: string;
  /** Optional agent group to use */
  agentGroupId?: string;
  /** Optional conversation ID to continue */
  conversationId?: string;
  /** Whether to wait for the agent response (sync) or return immediately (async) */
  sync?: boolean;
  /** Optional metadata passed through to the response */
  metadata?: Record<string, unknown>;
}

export interface InboundWebhookResponse {
  success: boolean;
  runId?: number;
  response?: string;
  conversationId?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

/** Supported webhook events */
export const WEBHOOK_EVENTS = [
  'agent:run:start',
  'agent:run:complete',
  'agent:run:error',
  'task:start',
  'task:complete',
  'task:error',
  'task:iteration',
  'approval:required',
  'approval:resolved',
  'scheduler:job:complete',
  'message:incoming',
  'message:reply',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number] | '*';
