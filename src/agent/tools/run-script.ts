import { spawn } from 'child_process';
import { AgentTool, ToolResult } from './types';

const MAX_OUTPUT_LENGTH = 20000;
const DEFAULT_TIMEOUT_MS = 30000;

export const runScriptTool: AgentTool = {
  name: 'run_script',
  description: `Execute a shell command or script and return its stdout/stderr output. Runs in the server's environment. Use for file operations, data processing, system commands, package management, etc. Commands run with a configurable timeout (default 30s).`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute (passed to /bin/sh -c)',
      },
      timeout_ms: {
        type: 'number',
        description: 'Maximum execution time in milliseconds (default: 30000)',
      },
      working_dir: {
        type: 'string',
        description: 'Working directory for the command (default: /tmp)',
      },
    },
    required: ['command'],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const command = input.command as string;
    const timeoutMs = (input.timeout_ms as number) || DEFAULT_TIMEOUT_MS;
    const workingDir = (input.working_dir as string) || '/tmp';

    return new Promise<ToolResult>((resolve) => {
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let totalBytes = 0;
      let killed = false;

      // Filter out sensitive env vars
      const safeEnv: Record<string, string> = {};
      for (const [key, val] of Object.entries(process.env)) {
        if (val === undefined) continue;
        const lower = key.toLowerCase();
        if (
          lower.includes('key') ||
          lower.includes('secret') ||
          lower.includes('token') ||
          lower.includes('password') ||
          lower.includes('pass')
        ) {
          continue;
        }
        safeEnv[key] = val;
      }

      const proc = spawn('/bin/sh', ['-c', command], {
        cwd: workingDir,
        env: safeEnv,
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= MAX_OUTPUT_LENGTH * 2) {
          chunks.push(chunk);
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= MAX_OUTPUT_LENGTH * 2) {
          errChunks.push(chunk);
        }
      });

      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGKILL');
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);

        let stdout = Buffer.concat(chunks).toString('utf-8');
        let stderr = Buffer.concat(errChunks).toString('utf-8');

        if (stdout.length > MAX_OUTPUT_LENGTH) {
          stdout = stdout.slice(0, MAX_OUTPUT_LENGTH) + '\n...(stdout truncated)';
        }
        if (stderr.length > MAX_OUTPUT_LENGTH) {
          stderr = stderr.slice(0, MAX_OUTPUT_LENGTH) + '\n...(stderr truncated)';
        }

        const parts: string[] = [];
        if (killed) {
          parts.push(`[TIMEOUT after ${timeoutMs}ms - process killed]`);
        }
        parts.push(`Exit code: ${code ?? 'unknown'}`);
        if (stdout) parts.push(`stdout:\n${stdout}`);
        if (stderr) parts.push(`stderr:\n${stderr}`);

        resolve({
          content: parts.join('\n\n'),
          isError: killed || code !== 0,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          content: `Failed to execute command: ${err.message}`,
          isError: true,
        });
      });
    });
  },
};
