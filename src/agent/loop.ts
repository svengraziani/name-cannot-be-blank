import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import { config } from '../config';
import {
  getConversationMessages,
  addMessage,
  createAgentRun,
  updateAgentRun,
} from '../db/sqlite';
import { EventEmitter } from 'events';

export const agentEvents = new EventEmitter();

let systemPrompt = 'You are a helpful AI assistant.';

export function loadSystemPrompt(): void {
  try {
    if (fs.existsSync(config.agentSystemPromptFile)) {
      systemPrompt = fs.readFileSync(config.agentSystemPromptFile, 'utf-8');
      console.log(`[agent] Loaded system prompt from ${config.agentSystemPromptFile}`);
    }
  } catch (err) {
    console.warn('[agent] Could not load system prompt file, using default:', err);
  }
}

let client: Anthropic;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return client;
}

interface AgentResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Process a message through the agent loop:
 * 1. Load conversation history
 * 2. Build context (system prompt + history + new message)
 * 3. Call Claude API
 * 4. Store response + track usage
 * 5. Emit events for UI
 */
export async function processMessage(
  conversationId: string,
  userMessage: string,
  channelType: string,
  sender: string,
): Promise<string> {
  // Store user message
  const msgId = addMessage(conversationId, 'user', userMessage, channelType, sender);
  const runId = createAgentRun(conversationId, msgId);

  agentEvents.emit('run:start', { runId, conversationId, channelType });

  try {
    updateAgentRun(runId, { status: 'running' });

    // Build conversation context
    const history = getConversationMessages(conversationId, 40);
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = history.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    // Call Claude
    const response = await callAgent(messages);

    // Store assistant response
    addMessage(conversationId, 'assistant', response.content, channelType);

    updateAgentRun(runId, {
      status: 'completed',
      input_tokens: response.inputTokens,
      output_tokens: response.outputTokens,
    });

    agentEvents.emit('run:complete', {
      runId,
      conversationId,
      channelType,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    });

    return response.content;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    updateAgentRun(runId, { status: 'error', error: errorMsg });
    agentEvents.emit('run:error', { runId, conversationId, error: errorMsg });
    console.error('[agent] Error processing message:', errorMsg);
    throw err;
  }
}

async function callAgent(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<AgentResponse> {
  const response = await getClient().messages.create({
    model: config.agentModel,
    max_tokens: config.agentMaxTokens,
    system: systemPrompt,
    messages,
  });

  const textBlocks = response.content.filter(b => b.type === 'text');
  const content = textBlocks.map(b => b.text).join('\n');

  return {
    content,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
