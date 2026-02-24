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
import { toolRegistry } from './tools';
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
  toolCalls: number;
}

// Maximum number of tool-use iterations per message to prevent runaway loops
const MAX_TOOL_ITERATIONS = 25;

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
 * 3. Call Claude API with tools (agentic loop)
 * 4. Store response + track usage
 * 5. Emit events for UI
 */
export async function processMessage(
  conversationId: string,
  userMessage: string,
  channelType: string,
  sender: string,
  enabledTools?: string[],
): Promise<string> {
  // Store user message
  const msgId = addMessage(conversationId, 'user', userMessage, channelType, sender);
  const runId = createAgentRun(conversationId, msgId);

  agentEvents.emit('run:start', { runId, conversationId, channelType });

  try {
    updateAgentRun(runId, { status: 'running' });

    // Build conversation context
    const history = getConversationMessages(conversationId, 40);
    const messages: Anthropic.MessageParam[] = history.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    // Call Claude - either via container or directly
    let response: AgentResponse;
    const startTime = Date.now();

    if (isContainerMode()) {
      // Container mode doesn't support tools yet - pass through without tools
      response = await callAgentContainer(messages);
    } else {
      response = await callAgentDirect(messages, enabledTools, runId);
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
      toolCalls: response.toolCalls,
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
 * Direct API call with agentic tool-use loop.
 * Calls Claude, executes any tool_use requests, feeds results back,
 * and repeats until Claude produces a final text response.
 */
async function callAgentDirect(
  messages: Anthropic.MessageParam[],
  enabledTools?: string[],
  runId?: number,
): Promise<AgentResponse> {
  const tools = toolRegistry.getToolDefinitions(enabledTools);
  const currentMessages = [...messages];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalToolCalls = 0;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await getClient().messages.create({
      model: config.agentModel,
      max_tokens: config.agentMaxTokens,
      system: systemPrompt,
      messages: currentMessages,
      ...(tools.length > 0 ? { tools } : {}),
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    // If no tool use, extract text and return
    if (response.stop_reason !== 'tool_use') {
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === 'text'
      );
      const content = textBlocks.map(b => b.text).join('\n');

      return {
        content: content || '(no response)',
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        toolCalls: totalToolCalls,
      };
    }

    // Tool use requested - execute each tool call
    currentMessages.push({ role: 'assistant', content: response.content });

    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        totalToolCalls++;
        const toolInput = block.input as Record<string, unknown>;

        console.log(`[agent] Tool call #${totalToolCalls}: ${block.name}(${JSON.stringify(toolInput).slice(0, 200)})`);
        agentEvents.emit('tool:call', {
          runId,
          iteration,
          tool: block.name,
          input: toolInput,
        });

        const result = await toolRegistry.execute(block.name, toolInput);

        console.log(`[agent] Tool result: ${result.isError ? 'ERROR' : 'OK'} (${result.content.length} chars)`);
        agentEvents.emit('tool:result', {
          runId,
          iteration,
          tool: block.name,
          isError: result.isError || false,
          contentLength: result.content.length,
        });

        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.content,
          is_error: result.isError,
        });
      }
    }

    // Feed tool results back to Claude
    currentMessages.push({ role: 'user', content: toolResultBlocks });
  }

  // If we exhausted iterations, return whatever we have
  return {
    content: '(max tool iterations reached - please try a simpler request)',
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    toolCalls: totalToolCalls,
  };
}

/**
 * Containerized API call (nanoclaw pattern).
 * Passes API key via stdin, runs in isolated Docker container.
 * Note: Tool use is not supported in container mode.
 */
async function callAgentContainer(
  messages: Anthropic.MessageParam[],
): Promise<AgentResponse> {
  // Container mode only supports simple text messages (no tool blocks)
  const simpleMessages = messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : '(tool interaction)',
  }));

  const input: ContainerInput = {
    apiKey: config.anthropicApiKey,
    model: config.agentModel,
    maxTokens: config.agentMaxTokens,
    systemPrompt,
    messages: simpleMessages,
  };

  const result = await runInContainer(input);
  return { ...result, toolCalls: 0 };
}
