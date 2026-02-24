import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import { config } from '../config';
import {
  getConversationMessages,
  addMessage,
  createAgentRun,
  updateAgentRun,
  logApiCall,
} from '../db/sqlite';
import { runInContainer, checkContainerRuntime, ContainerInput } from './container-runner';
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

// Container isolation mode
let containerMode = process.env.AGENT_CONTAINER_MODE === 'true';
let containerAvailable = false;

export async function initAgentRuntime(): Promise<void> {
  if (containerMode) {
    const check = await checkContainerRuntime();
    if (check.available) {
      containerAvailable = true;
      console.log('[agent] Container isolation mode: ENABLED');
    } else {
      console.warn(`[agent] Container mode requested but unavailable: ${check.error}`);
      console.warn('[agent] Falling back to direct mode');
      containerMode = false;
    }
  } else {
    console.log('[agent] Running in direct mode (set AGENT_CONTAINER_MODE=true for isolation)');
  }
}

export function isContainerMode(): boolean {
  return containerMode && containerAvailable;
}

/**
 * Process a message through the agent loop:
 * 1. Load conversation history
 * 2. Build context (system prompt + history + new message)
 * 3. Call Claude API (direct or via container)
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

    // Call Claude - either via container or directly
    let response: AgentResponse;
    const startTime = Date.now();

    if (isContainerMode()) {
      response = await callAgentContainer(messages);
    } else {
      response = await callAgentDirect(messages);
    }

    const durationMs = Date.now() - startTime;

    // Log API call for usage tracking
    logApiCall({
      conversation_id: conversationId,
      model: config.agentModel,
      input_tokens: response.inputTokens,
      output_tokens: response.outputTokens,
      duration_ms: durationMs,
      isolated: isContainerMode(),
    });

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
      durationMs,
      containerMode: isContainerMode(),
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

/**
 * Direct API call (no container isolation).
 */
async function callAgentDirect(
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

/**
 * Containerized API call (nanoclaw pattern).
 * Passes API key via stdin, runs in isolated Docker container.
 */
async function callAgentContainer(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<AgentResponse> {
  const input: ContainerInput = {
    apiKey: config.anthropicApiKey,
    model: config.agentModel,
    maxTokens: config.agentMaxTokens,
    systemPrompt,
    messages,
  };

  return runInContainer(input);
}
