import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import { config } from '../config';
import { getConversationMessages, addMessage, createAgentRun, updateAgentRun, logApiCall } from '../db/sqlite';
import { runInContainer, checkContainerRuntime, ContainerInput } from './container-runner';
import { toolRegistry } from './tools';
import { FileAttachment } from './tools/types';
import { EventEmitter } from 'events';
import { ResolvedAgentConfig } from './groups/resolver';
import { setA2AContext } from './a2a';
import { checkApprovalRequired, requestApproval } from './hitl';
import { setGitContext } from './tools/git-repo';

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

export function getSystemPrompt(): string {
  return systemPrompt;
}

// Cache of Anthropic clients keyed by API key
const clientCache = new Map<string, Anthropic>();

function getClient(apiKey?: string): Anthropic {
  const key = apiKey || config.anthropicApiKey;
  let cached = clientCache.get(key);
  if (!cached) {
    cached = new Anthropic({ apiKey: key });
    clientCache.set(key, cached);
  }
  return cached;
}

interface AgentResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  files?: FileAttachment[];
}

export interface ProcessMessageResult {
  content: string;
  files?: FileAttachment[];
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
 *
 * Optionally accepts a ResolvedAgentConfig for group-specific settings.
 */
export async function processMessage(
  conversationId: string,
  userMessage: string,
  channelType: string,
  sender: string,
  enabledTools?: string[],
  agentConfig?: ResolvedAgentConfig,
): Promise<ProcessMessageResult> {
  // Store user message
  const msgId = addMessage(conversationId, 'user', userMessage, channelType, sender);
  const runId = createAgentRun(conversationId, msgId);

  agentEvents.emit('run:start', { runId, conversationId, channelType, groupId: agentConfig?.groupId });

  try {
    updateAgentRun(runId, { status: 'running' });

    // Build conversation context
    const history = getConversationMessages(conversationId, 20);
    const messages: Anthropic.MessageParam[] = history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    // Determine effective settings (group config or global defaults)
    const effectiveModel = agentConfig?.model || config.agentModel;
    const effectiveMaxTokens = agentConfig?.maxTokens || config.agentMaxTokens;
    const effectiveSystemPrompt = agentConfig?.systemPrompt || systemPrompt;
    const effectiveApiKey = agentConfig?.apiKey || config.anthropicApiKey;
    const effectiveTools = agentConfig?.enabledSkills || enabledTools;
    const useContainer = agentConfig?.containerMode ?? isContainerMode();

    // Set A2A context so delegate_task and other A2A tools work correctly
    setA2AContext({
      groupId: agentConfig?.groupId || '',
      agentId: `agent-${runId}`,
      conversationId,
    });

    // Set Git context so git_clone can resolve repo/token from group config
    setGitContext({
      githubRepo: agentConfig?.githubRepo,
      githubToken: agentConfig?.githubToken,
    });

    // Call Claude - either via container or directly
    let response: AgentResponse;
    const startTime = Date.now();

    if (useContainer && containerAvailable) {
      response = await callAgentContainer(
        messages,
        effectiveSystemPrompt,
        effectiveModel,
        effectiveMaxTokens,
        effectiveApiKey,
      );
    } else {
      response = await callAgentDirect(
        messages,
        effectiveTools,
        runId,
        conversationId,
        agentConfig?.groupId,
        effectiveSystemPrompt,
        effectiveModel,
        effectiveMaxTokens,
        effectiveApiKey,
      );
    }

    const durationMs = Date.now() - startTime;

    // Log API call for usage tracking
    logApiCall({
      conversation_id: conversationId,
      model: effectiveModel,
      input_tokens: response.inputTokens,
      output_tokens: response.outputTokens,
      duration_ms: durationMs,
      isolated: useContainer && containerAvailable,
      agent_group_id: agentConfig?.groupId,
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
      groupId: agentConfig?.groupId,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      toolCalls: response.toolCalls,
      durationMs,
      containerMode: useContainer,
    });

    return { content: response.content, files: response.files };
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
  conversationId?: string,
  groupId?: string,
  overrideSystemPrompt?: string,
  overrideModel?: string,
  overrideMaxTokens?: number,
  overrideApiKey?: string,
): Promise<AgentResponse> {
  const tools = toolRegistry.getToolDefinitions(enabledTools);
  const currentMessages = [...messages];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalToolCalls = 0;
  const collectedFiles: FileAttachment[] = [];

  const model = overrideModel || config.agentModel;
  const maxTokens = overrideMaxTokens || config.agentMaxTokens;
  const sysPrompt = overrideSystemPrompt || systemPrompt;
  const client = getClient(overrideApiKey);

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: sysPrompt,
      messages: currentMessages,
      ...(tools.length > 0 ? { tools } : {}),
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    // If no tool use, extract text and return
    if (response.stop_reason !== 'tool_use') {
      const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
      let content = textBlocks.map((b) => b.text).join('\n');

      // If we hit the token limit mid-generation, the response is truncated.
      // Log a warning so we can diagnose, and append a note for the user.
      if (response.stop_reason === 'max_tokens') {
        console.warn(
          `[agent] Response truncated at max_tokens (${maxTokens}) on iteration ${iteration}, tool calls so far: ${totalToolCalls}`,
        );
        content += '\n\n(Response was cut short due to length limits. Please try a shorter or simpler request.)';
      }

      return {
        content: content || '(no response)',
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        toolCalls: totalToolCalls,
        files: collectedFiles.length > 0 ? collectedFiles : undefined,
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

        // --- HITL Approval Gate ---
        const approvalCheck = checkApprovalRequired(block.name);
        if (approvalCheck.required && runId) {
          console.log(`[agent] Approval required for ${block.name} (risk: ${approvalCheck.riskLevel})`);
          agentEvents.emit('tool:approval_required', {
            runId,
            iteration,
            tool: block.name,
            input: toolInput,
            riskLevel: approvalCheck.riskLevel,
          });

          const { promise: approvalPromise } = requestApproval({
            runId,
            conversationId: conversationId || '',
            groupId,
            toolName: block.name,
            toolInput,
            riskLevel: approvalCheck.riskLevel,
            timeoutSeconds: approvalCheck.timeoutSeconds,
            timeoutAction: approvalCheck.timeoutAction,
          });
          const approvalResult = await approvalPromise;

          if (!approvalResult.approved) {
            console.log(`[agent] Tool ${block.name} rejected: ${approvalResult.reason || 'no reason'}`);
            agentEvents.emit('tool:approval_rejected', {
              runId,
              iteration,
              tool: block.name,
              reason: approvalResult.reason,
            });

            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Tool call rejected by human reviewer: ${approvalResult.reason || 'Not approved'}. Please adjust your approach or ask the user for guidance.`,
              is_error: true,
            });
            continue;
          }

          console.log(`[agent] Tool ${block.name} approved by ${approvalResult.respondedBy || 'reviewer'}`);
        }
        // --- End HITL Approval Gate ---

        const result = await toolRegistry.execute(block.name, toolInput);

        // Collect file attachments from tool results (charts, PDFs, Excel files, etc.)
        if (result.files && result.files.length > 0) {
          collectedFiles.push(...result.files);
          console.log(
            `[agent] Tool ${block.name} produced ${result.files.length} file(s): ${result.files.map((f) => f.filename).join(', ')}`,
          );
        }

        console.log(
          `[agent] Tool result: ${result.isError ? 'ERROR' : 'OK'} (${result.content.length} chars)${result.isError ? ' — ' + result.content.slice(0, 500) : ''}`,
        );
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
    files: collectedFiles.length > 0 ? collectedFiles : undefined,
  };
}

/**
 * Containerized API call (nanoclaw pattern).
 * Passes API key via stdin, runs in isolated Docker container.
 * Note: Tool use is not supported in container mode.
 */
async function callAgentContainer(
  messages: Anthropic.MessageParam[],
  overrideSystemPrompt?: string,
  overrideModel?: string,
  overrideMaxTokens?: number,
  overrideApiKey?: string,
): Promise<AgentResponse> {
  // Container mode only supports simple text messages (no tool blocks)
  const simpleMessages = messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : '(tool interaction)',
  }));

  const input: ContainerInput = {
    apiKey: overrideApiKey || config.anthropicApiKey,
    model: overrideModel || config.agentModel,
    maxTokens: overrideMaxTokens || config.agentMaxTokens,
    systemPrompt: overrideSystemPrompt || systemPrompt,
    messages: simpleMessages,
  };

  const result = await runInContainer(input);
  return { ...result, toolCalls: 0 };
}
