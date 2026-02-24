/**
 * Container Runner - Spawns isolated Docker containers for agent runs.
 *
 * Inspired by NanoClaw's approach:
 * - Each agent run happens in its own container
 * - Secrets passed via stdin only (never on disk or env)
 * - Configurable timeouts and concurrency limits
 * - Sentinel markers for reliable output parsing
 */

import { spawn } from 'child_process';
import { config } from '../config';
import { EventEmitter } from 'events';

const OUTPUT_START = '===AGENT_OUTPUT_START===';
const OUTPUT_END = '===AGENT_OUTPUT_END===';

const AGENT_IMAGE = 'loop-gateway-agent:latest';
const CONTAINER_TIMEOUT_MS = parseInt(process.env.CONTAINER_TIMEOUT_MS || '600000', 10); // 10 min default
const MAX_CONCURRENT_CONTAINERS = parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '3', 10);

export const containerEvents = new EventEmitter();

let activeContainers = 0;
const queue: Array<{
  resolve: (result: ContainerResult) => void;
  reject: (err: Error) => void;
  input: ContainerInput;
}> = [];

export interface ContainerInput {
  apiKey: string;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface ContainerResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Run an agent invocation inside an isolated Docker container.
 * Enforces global concurrency limit with a FIFO queue.
 */
export function runInContainer(input: ContainerInput): Promise<ContainerResult> {
  return new Promise((resolve, reject) => {
    queue.push({ resolve, reject, input });
    processQueue();
  });
}

function processQueue() {
  while (queue.length > 0 && activeContainers < MAX_CONCURRENT_CONTAINERS) {
    const item = queue.shift()!;
    activeContainers++;
    containerEvents.emit('container:start', { active: activeContainers, queued: queue.length });

    executeContainer(item.input)
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        activeContainers--;
        containerEvents.emit('container:end', { active: activeContainers, queued: queue.length });
        processQueue();
      });
  }
}

async function executeContainer(input: ContainerInput): Promise<ContainerResult> {
  return new Promise((resolve, reject) => {
    const args = [
      'run',
      '--rm',                              // Auto-remove after exit
      '-i',                                // Interactive (stdin)
      '--network=none',                    // No network access for isolation
      '--memory=512m',                     // Memory limit
      '--cpus=0.5',                        // CPU limit
      '--read-only',                       // Read-only filesystem
      '--tmpfs=/tmp:rw,noexec,nosuid',     // Writable tmp only
      '--name', `agent-run-${Date.now()}`,
      AGENT_IMAGE,
    ];

    // Allow network for API calls - override --network=none
    // The agent needs to reach the Anthropic API
    args.splice(args.indexOf('--network=none'), 1);

    const child = spawn('docker', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Pass all input via stdin - secrets never on disk
    const payload = JSON.stringify(input);
    child.stdin.write(payload);
    child.stdin.end();

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      const line = data.toString();
      stderr += line;
      // Forward agent-runner logs
      process.stderr.write(`[container] ${line}`);
    });

    // Timeout: kill container after CONTAINER_TIMEOUT_MS
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 10000);
      reject(new Error(`Container timed out after ${CONTAINER_TIMEOUT_MS}ms`));
    }, CONTAINER_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timeout);

      // Parse output between sentinel markers
      const startIdx = stdout.indexOf(OUTPUT_START);
      const endIdx = stdout.indexOf(OUTPUT_END);

      if (startIdx === -1 || endIdx === -1) {
        reject(new Error(`Container output parsing failed (exit code ${code}): ${stderr.slice(0, 500)}`));
        return;
      }

      const jsonStr = stdout.slice(startIdx + OUTPUT_START.length, endIdx).trim();

      try {
        const result = JSON.parse(jsonStr);

        if (result.error) {
          reject(new Error(`Agent error: ${result.error}`));
          return;
        }

        resolve({
          content: result.content,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });
      } catch (err) {
        reject(new Error(`Failed to parse container output: ${err}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn container: ${err.message}`));
    });
  });
}

/**
 * Check if Docker is available and the agent image exists.
 */
export async function checkContainerRuntime(): Promise<{ available: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['image', 'inspect', AGENT_IMAGE], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ available: true });
      } else {
        resolve({
          available: false,
          error: `Agent image '${AGENT_IMAGE}' not found. Build with: cd agent-runner && docker build -t ${AGENT_IMAGE} .`,
        });
      }
    });

    child.on('error', () => {
      resolve({ available: false, error: 'Docker not available' });
    });
  });
}

export function getContainerStats() {
  return {
    active: activeContainers,
    queued: queue.length,
    maxConcurrent: MAX_CONCURRENT_CONTAINERS,
    timeoutMs: CONTAINER_TIMEOUT_MS,
  };
}
