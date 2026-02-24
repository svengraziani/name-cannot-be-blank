/**
 * Loop Mode - Ralph-Wiggum Pattern
 *
 * Autonomous task execution via prompt files:
 * - PROMPT_plan.md: Agent reads the prompt, creates a plan, writes output
 * - PROMPT_build.md: Agent reads the prompt, executes the build, writes output
 *
 * Each task loops: read prompt → run agent → write output → check completion
 * Tasks can be created via API and run autonomously.
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import {
  createLoopTask,
  getLoopTask,
  getAllLoopTasks,
  updateLoopTask,
  deleteLoopTask,
  LoopTaskRow,
  logApiCall,
} from '../db/sqlite';
import { EventEmitter } from 'events';
import Anthropic from '@anthropic-ai/sdk';

export const loopEvents = new EventEmitter();

const PROMPTS_DIR = path.join(config.dataDir, 'prompts');
const OUTPUT_DIR = path.join(config.dataDir, 'loop-output');

// Ensure directories exist
function ensureDirs() {
  for (const dir of [PROMPTS_DIR, OUTPUT_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// Active loop tasks
const activeLoops = new Map<number, { cancel: () => void }>();

let client: Anthropic;
function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return client;
}

/**
 * Create and start a new loop task.
 */
export function createAndStartTask(opts: { name: string; promptContent: string; maxIterations?: number }): number {
  ensureDirs();

  const safeName = opts.name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const promptFile = path.join(PROMPTS_DIR, `PROMPT_${safeName}.md`);
  const outputFile = path.join(OUTPUT_DIR, `OUTPUT_${safeName}.md`);

  // Write prompt file
  fs.writeFileSync(promptFile, opts.promptContent, 'utf-8');

  const taskId = createLoopTask({
    name: opts.name,
    prompt_file: promptFile,
    output_file: outputFile,
    max_iterations: opts.maxIterations || 10,
  });

  // Start the loop
  startTaskLoop(taskId);

  return taskId;
}

/**
 * Start the loop for a specific task.
 */
export function startTaskLoop(taskId: number): void {
  const task = getLoopTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (task.status === 'running') throw new Error(`Task ${taskId} is already running`);

  let cancelled = false;

  activeLoops.set(taskId, {
    cancel: () => {
      cancelled = true;
    },
  });

  updateLoopTask(taskId, { status: 'running' });
  loopEvents.emit('task:start', { taskId, name: task.name });

  // Run the loop asynchronously
  void (async () => {
    try {
      let iteration = task.iteration;

      while (iteration < task.max_iterations && !cancelled) {
        iteration++;
        updateLoopTask(taskId, { iteration });

        loopEvents.emit('task:iteration', { taskId, iteration, maxIterations: task.max_iterations });
        console.log(`[loop] Task ${taskId} "${task.name}" - iteration ${iteration}/${task.max_iterations}`);

        // Read the prompt file
        if (!fs.existsSync(task.prompt_file)) {
          throw new Error(`Prompt file not found: ${task.prompt_file}`);
        }

        const prompt = fs.readFileSync(task.prompt_file, 'utf-8');

        // Build context: include previous output if available
        let contextMessage = prompt;
        if (task.output_file && fs.existsSync(task.output_file)) {
          const previousOutput = fs.readFileSync(task.output_file, 'utf-8');
          if (previousOutput.trim()) {
            contextMessage = `## Previous Output (iteration ${iteration - 1})\n\n${previousOutput}\n\n---\n\n## Current Task (iteration ${iteration})\n\n${prompt}`;
          }
        }

        // Call the agent
        const startTime = Date.now();
        const response = await getClient().messages.create({
          model: config.agentModel,
          max_tokens: config.agentMaxTokens,
          system: `You are an autonomous agent executing a loop task. Each iteration builds on the previous output. Be thorough and indicate when the task is COMPLETE by including the word "TASK_COMPLETE" in your response.`,
          messages: [{ role: 'user', content: contextMessage }],
        });

        const durationMs = Date.now() - startTime;
        const textBlocks = response.content.filter((b) => b.type === 'text');
        const output = textBlocks.map((b) => b.text).join('\n');

        // Log API call
        logApiCall({
          model: config.agentModel,
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          duration_ms: durationMs,
          isolated: false,
        });

        // Write output file
        if (task.output_file) {
          fs.writeFileSync(task.output_file, output, 'utf-8');
        }

        updateLoopTask(taskId, { last_output: output.slice(0, 5000) });

        loopEvents.emit('task:output', {
          taskId,
          iteration,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          outputPreview: output.slice(0, 200),
        });

        // Check for completion signal
        if (output.includes('TASK_COMPLETE')) {
          console.log(`[loop] Task ${taskId} signaled COMPLETE at iteration ${iteration}`);
          break;
        }

        // Small delay between iterations
        if (!cancelled) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      updateLoopTask(taskId, { status: 'completed' });
      loopEvents.emit('task:complete', { taskId, iterations: iteration });
      console.log(`[loop] Task ${taskId} completed after ${iteration} iterations`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      updateLoopTask(taskId, { status: 'error', error: errorMsg });
      loopEvents.emit('task:error', { taskId, error: errorMsg });
      console.error(`[loop] Task ${taskId} error:`, errorMsg);
    } finally {
      activeLoops.delete(taskId);
    }
  })();
}

/**
 * Stop a running loop task.
 */
export function stopTask(taskId: number): void {
  const active = activeLoops.get(taskId);
  if (active) {
    active.cancel();
    activeLoops.delete(taskId);
    updateLoopTask(taskId, { status: 'stopped' });
    loopEvents.emit('task:stop', { taskId });
  }
}

/**
 * Get all tasks with their current status.
 */
export function getTasks(): LoopTaskRow[] {
  return getAllLoopTasks();
}

/**
 * Remove a task (stops it first if running).
 */
export function removeTask(taskId: number): void {
  stopTask(taskId);

  const task = getLoopTask(taskId);
  if (task) {
    // Clean up files
    try {
      if (fs.existsSync(task.prompt_file)) fs.unlinkSync(task.prompt_file);
      if (task.output_file && fs.existsSync(task.output_file)) fs.unlinkSync(task.output_file);
    } catch {
      // ignore cleanup errors
    }
    deleteLoopTask(taskId);
  }
}

/**
 * Get the prompt file contents for a task.
 */
export function getTaskPrompt(taskId: number): string | null {
  const task = getLoopTask(taskId);
  if (!task) return null;
  try {
    return fs.readFileSync(task.prompt_file, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Get the output file contents for a task.
 */
export function getTaskOutput(taskId: number): string | null {
  const task = getLoopTask(taskId);
  if (!task?.output_file) return null;
  try {
    return fs.readFileSync(task.output_file, 'utf-8');
  } catch {
    return null;
  }
}
