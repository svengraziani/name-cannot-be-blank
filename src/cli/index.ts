#!/usr/bin/env node

/**
 * loop-gw CLI
 *
 * Direct terminal interface to the Loop Gateway API.
 *
 * Usage:
 *   loop-gw chat "What is the status of Order 4523?"
 *   loop-gw task create --prompt "Build a report" --iterations 5
 *   loop-gw task list
 *   loop-gw task stop <id>
 *   loop-gw task output <id>
 *   loop-gw task delete <id>
 *   loop-gw status
 *   loop-gw usage
 *   loop-gw login
 *   loop-gw config set server http://localhost:3000
 */

import { apiRequest, loadConfig, saveConfig } from './client';
import * as readline from 'readline';

// --- Helpers ---

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[0m`;
}

function green(text: string): string {
  return `\x1b[32m${text}\x1b[0m`;
}

function red(text: string): string {
  return `\x1b[31m${text}\x1b[0m`;
}

function yellow(text: string): string {
  return `\x1b[33m${text}\x1b[0m`;
}

function cyan(text: string): string {
  return `\x1b[36m${text}\x1b[0m`;
}

function die(message: string): never {
  console.error(red(`Error: ${message}`));
  process.exit(1);
}

function parseFlags(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    if (hidden) {
      process.stdout.write(question);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      // Mute output for password
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((_chunk: string | Uint8Array) => true) as typeof process.stdout.write;
      rl.question('', (answer) => {
        process.stdout.write = originalWrite;
        process.stdout.write('\n');
        rl.close();
        resolve(answer);
      });
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

// --- Commands ---

async function cmdChat(args: string[]): Promise<void> {
  const { flags, positional } = parseFlags(args);
  const message = positional.join(' ');

  if (!message) {
    die('Usage: loop-gw chat "Your message here" [--conversation <id>]');
  }

  const convId = flags['conversation'] || flags['c'];
  console.log(dim('Sending message to agent...'));

  const body: Record<string, unknown> = { message };
  if (convId) body['conversationId'] = convId;

  const res = await apiRequest<{ reply: string; conversationId: string }>('POST', '/chat', body);

  if (!res.ok) {
    const err = (res.data as Record<string, string>)?.error || JSON.stringify(res.data);
    die(`API error (${res.status}): ${err}`);
  }

  console.log(`\n${bold('Agent')}  ${dim(`[conv: ${res.data.conversationId}]`)}\n`);
  console.log(res.data.reply);
}

async function cmdTaskList(): Promise<void> {
  const res = await apiRequest<Array<Record<string, unknown>>>('GET', '/tasks');
  if (!res.ok) die(`API error (${res.status})`);

  const tasks = res.data;
  if (!tasks.length) {
    console.log(dim('No tasks found.'));
    return;
  }

  console.log(bold('Loop Tasks\n'));
  console.log(['ID', 'Name', 'Status', 'Iterations'].map((h) => h.padEnd(16)).join(''));
  console.log('-'.repeat(64));
  for (const t of tasks) {
    const status =
      t.status === 'running'
        ? green(String(t.status))
        : t.status === 'error'
          ? red(String(t.status))
          : yellow(String(t.status));
    console.log(
      [
        String(t.id).padEnd(16),
        String(t.name).padEnd(16),
        String(status).padEnd(16 + 9),
        `${t.currentIteration ?? 0}/${t.maxIterations ?? '?'}`,
      ].join(''),
    );
  }
}

async function cmdTaskCreate(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const taskPrompt = flags['prompt'] || flags['p'];
  const name = flags['name'] || flags['n'] || 'cli-task';
  const iterations = parseInt(flags['iterations'] || flags['i'] || '10', 10);

  if (!taskPrompt) {
    die('Usage: loop-gw task create --prompt "..." [--name <name>] [--iterations <n>]');
  }

  const res = await apiRequest<{ id: number; status: string }>('POST', '/tasks', {
    name,
    prompt: taskPrompt,
    maxIterations: iterations,
  });

  if (!res.ok) {
    const err = (res.data as unknown as Record<string, string>)?.error || JSON.stringify(res.data);
    die(`API error (${res.status}): ${err}`);
  }

  console.log(green(`Task #${res.data.id} created and started.`));
}

async function cmdTaskStop(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die('Usage: loop-gw task stop <id>');

  const res = await apiRequest('POST', `/tasks/${id}/stop`);
  if (!res.ok) die(`API error (${res.status})`);
  console.log(green(`Task #${id} stopped.`));
}

async function cmdTaskOutput(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die('Usage: loop-gw task output <id>');

  const res = await apiRequest<{ output: string }>('GET', `/tasks/${id}/output`);
  if (!res.ok) die(`API error (${res.status})`);
  console.log(res.data.output || dim('(no output yet)'));
}

async function cmdTaskDelete(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) die('Usage: loop-gw task delete <id>');

  const res = await apiRequest('DELETE', `/tasks/${id}`);
  if (!res.ok) die(`API error (${res.status})`);
  console.log(green(`Task #${id} deleted.`));
}

async function cmdTask(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case 'list':
    case 'ls':
      return cmdTaskList();
    case 'create':
    case 'new':
      return cmdTaskCreate(rest);
    case 'stop':
      return cmdTaskStop(rest);
    case 'output':
    case 'out':
      return cmdTaskOutput(rest);
    case 'delete':
    case 'rm':
      return cmdTaskDelete(rest);
    default:
      die('Usage: loop-gw task <list|create|stop|output|delete>');
  }
}

async function cmdStatus(): Promise<void> {
  const res = await apiRequest<{ status: string; uptime: number; containerMode: boolean }>('GET', '/health');
  if (!res.ok) die(`Gateway unreachable (${res.status})`);

  const d = res.data;
  const uptimeMin = Math.floor(d.uptime / 60);
  const uptimeH = Math.floor(uptimeMin / 60);
  const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeMin % 60}m` : `${uptimeMin}m`;

  console.log(bold('Loop Gateway Status\n'));
  console.log(`  Status:          ${green(d.status)}`);
  console.log(`  Uptime:          ${uptimeStr}`);
  console.log(`  Container Mode:  ${d.containerMode ? yellow('enabled') : dim('disabled')}`);
  console.log(`  Server:          ${dim(loadConfig().server)}`);
}

async function cmdUsage(): Promise<void> {
  const res = await apiRequest<{
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCalls: number;
    estimatedCost: number;
    containerMode: boolean;
  }>('GET', '/usage');
  if (!res.ok) die(`API error (${res.status})`);

  const d = res.data;
  console.log(bold('Usage Summary\n'));
  console.log(`  API Calls:       ${d.totalCalls}`);
  console.log(`  Input Tokens:    ${d.totalInputTokens?.toLocaleString() ?? 0}`);
  console.log(`  Output Tokens:   ${d.totalOutputTokens?.toLocaleString() ?? 0}`);
  console.log(`  Est. Cost:       ${cyan('$' + (d.estimatedCost ?? 0).toFixed(4))}`);
}

async function cmdLogin(): Promise<void> {
  const cfg = loadConfig();
  console.log(dim(`Server: ${cfg.server}\n`));

  const username = await prompt('Username: ');
  const password = await prompt('Password: ', true);

  if (!username || !password) die('Username and password are required.');

  const res = await apiRequest<{ token?: string; expiresAt?: string; error?: string }>('POST', '/auth/login', {
    username,
    password,
  });

  if (!res.ok || !res.data.token) {
    die(res.data.error || 'Login failed.');
  }

  cfg.token = res.data.token;
  saveConfig(cfg);
  console.log(green('\nLogged in successfully. Token saved to ~/.loop-gw.json'));
}

function cmdConfig(args: string[]): void {
  const sub = args[0];

  if (sub === 'set') {
    const key = args[1];
    const value = args[2];
    if (!key || !value) die('Usage: loop-gw config set <key> <value>');

    const cfg = loadConfig();
    if (key === 'server') {
      cfg.server = value;
    } else if (key === 'token') {
      cfg.token = value;
    } else {
      die(`Unknown config key: ${key}. Available: server, token`);
    }
    saveConfig(cfg);
    console.log(green(`Config "${key}" set to "${value}"`));
    return;
  }

  if (sub === 'show' || !sub) {
    const cfg = loadConfig();
    console.log(bold('CLI Configuration\n'));
    console.log(`  Server:  ${cfg.server}`);
    console.log(`  Token:   ${cfg.token ? dim(cfg.token.slice(0, 8) + '...') : dim('(not set)')}`);
    return;
  }

  die('Usage: loop-gw config [show|set <key> <value>]');
}

function showHelp(): void {
  console.log(`
${bold('loop-gw')} -- Loop Gateway CLI

${bold('USAGE')}
  loop-gw <command> [options]

${bold('COMMANDS')}
  ${cyan('chat')} <message> [--conversation <id>]     Send a message to the agent
  ${cyan('task')} list                                 List all loop tasks
  ${cyan('task')} create --prompt "..." [options]      Create and start a loop task
       --name <name>                          Task name (default: cli-task)
       --iterations <n>                       Max iterations (default: 10)
  ${cyan('task')} stop <id>                            Stop a running task
  ${cyan('task')} output <id>                          Get task output
  ${cyan('task')} delete <id>                          Delete a task
  ${cyan('status')}                                    Show gateway status
  ${cyan('usage')}                                     Show token usage & costs
  ${cyan('login')}                                     Authenticate with the gateway
  ${cyan('config')} show                               Show current configuration
  ${cyan('config')} set <key> <value>                  Set a config value (server, token)

${bold('EXAMPLES')}
  loop-gw chat "What is the status of Order 4523?"
  loop-gw task create --prompt "Analyze sales data" --iterations 5
  loop-gw config set server http://my-gateway:3000
  loop-gw login
`);
}

// --- Main ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);

  try {
    switch (command) {
      case 'chat':
        return await cmdChat(rest);
      case 'task':
      case 'tasks':
        return await cmdTask(rest);
      case 'status':
      case 'health':
        return await cmdStatus();
      case 'usage':
        return await cmdUsage();
      case 'login':
        return await cmdLogin();
      case 'config':
        return cmdConfig(rest);
      case 'help':
      case '--help':
      case '-h':
        return showHelp();
      case 'version':
      case '--version':
      case '-v':
        console.log('loop-gw 1.0.0');
        return;
      default:
        showHelp();
        if (command) {
          die(`Unknown command: ${command}`);
        }
    }
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
