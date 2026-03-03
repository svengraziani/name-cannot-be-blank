/**
 * MCP Docker Container Lifecycle Management
 *
 * Manages Docker containers for MCP servers — pull, start, stop, remove, logs.
 * Uses child_process.spawn('docker', ...) following the same pattern as container-runner.ts.
 */

import { spawn } from 'child_process';
import * as net from 'net';
import type { McpServerConfig } from './types';

const DOCKER_LABEL_PREFIX = 'loop-gateway.mcp';
const MCP_PORT_RANGE_START = 9100;
const MCP_PORT_RANGE_END = 9200;

/**
 * Pull a Docker image. Returns when the pull completes.
 */
export async function pullImage(image: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['pull', image], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`docker pull failed (exit ${code}): ${stderr.trim()}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to run docker pull: ${err.message}`));
    });
  });
}

/**
 * Start a Docker container for an MCP server.
 * Returns the container ID.
 */
export async function startContainer(config: McpServerConfig, hostPort?: number): Promise<string> {
  const containerName = makeContainerName(config.id, config.name);

  // Clean up any leftover container with the same name
  await removeContainerByName(containerName);

  const args: string[] = ['run', '-d'];

  // For stdio transport, we need -i so we can attach later
  if (config.transport === 'stdio') {
    args.push('-i');
  }

  // Container name
  args.push('--name', containerName);

  // Labels for identification
  args.push('--label', `${DOCKER_LABEL_PREFIX}=true`);
  args.push('--label', `${DOCKER_LABEL_PREFIX}.id=${config.id}`);

  // Port mapping for SSE transport
  if (config.transport === 'sse' && hostPort && config.port) {
    args.push('-p', `${hostPort}:${config.port}`);
  }

  // Environment variables
  for (const [key, value] of Object.entries(config.env)) {
    args.push('-e', `${key}=${value}`);
  }

  // Volume mounts
  for (const vol of config.volumes) {
    args.push('-v', vol);
  }

  // Image
  args.push(config.image);

  // Command and args override
  if (config.command) {
    args.push(config.command);
  }
  if (config.args && config.args.length > 0) {
    args.push(...config.args);
  }

  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim()); // Container ID
      } else {
        reject(new Error(`docker run failed (exit ${code}): ${stderr.trim()}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to run docker run: ${err.message}`));
    });
  });
}

/**
 * Stop a running container by its container ID.
 */
export async function stopContainer(containerId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['stop', '-t', '10', containerId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        // Container may already be stopped — that's OK
        resolve();
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to stop container: ${err.message}`));
    });
  });
}

/**
 * Remove a container by its container ID.
 */
export async function removeContainer(containerId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['rm', '-f', containerId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.on('close', () => {
      resolve(); // Always resolve — container may not exist
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to remove container: ${err.message}`));
    });
  });
}

/**
 * Remove a container by its name (used for cleanup).
 */
async function removeContainerByName(name: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['rm', '-f', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

/**
 * Check if a container is running.
 */
export async function isContainerRunning(containerId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['inspect', '-f', '{{.State.Running}}', containerId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.on('close', (code) => {
      resolve(code === 0 && stdout.trim() === 'true');
    });

    child.on('error', () => resolve(false));
  });
}

/**
 * Get container logs.
 */
export async function getContainerLogs(containerId: string, lines = 100): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['logs', '--tail', String(lines), containerId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      output += data.toString();
    });

    child.on('close', () => {
      resolve(output);
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to get logs: ${err.message}`));
    });
  });
}

/**
 * Clean up all MCP containers (used during graceful shutdown or stale cleanup).
 */
export async function cleanupMcpContainers(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['ps', '-a', '-q', '--filter', `label=${DOCKER_LABEL_PREFIX}=true`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.on('close', () => {
      const ids = stdout
        .trim()
        .split('\n')
        .filter((id) => id.length > 0);
      void (async () => {
        for (const id of ids) {
          await stopContainer(id);
          await removeContainer(id);
        }
        resolve(ids.length);
      })();
    });

    child.on('error', () => resolve(0));
  });
}

/**
 * Find a free port in the MCP port range.
 */
export async function findFreePort(): Promise<number> {
  for (let port = MCP_PORT_RANGE_START; port < MCP_PORT_RANGE_END; port++) {
    const free = await isPortFree(port);
    if (free) return port;
  }
  throw new Error(`No free port found in range ${MCP_PORT_RANGE_START}-${MCP_PORT_RANGE_END}`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Check if Docker is available.
 */
export async function checkDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['info'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Get the docker exec command to attach to a container's stdin/stdout (for stdio transport).
 */
export function getStdioCommand(containerId: string): { command: string; args: string[] } {
  return {
    command: 'docker',
    args: ['attach', '--sig-proxy=false', containerId],
  };
}

function makeContainerName(id: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20);
  return `mcp-${id.slice(0, 8)}-${slug}`;
}
