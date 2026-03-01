/**
 * MCP Server Manager
 *
 * Orchestrates Docker containers, MCP client connections, and tool registration.
 * Coordinates the full lifecycle: pull → start → connect → discover → register.
 */

import { EventEmitter } from 'events';
import {
  getMcpServer,
  getAllMcpServers,
  updateMcpServerStatus,
  updateMcpServerToolsCache,
  clearMcpServerRuntime,
} from './db';
import {
  pullImage,
  startContainer,
  stopContainer,
  removeContainer,
  isContainerRunning,
  findFreePort,
  getContainerLogs,
  checkDockerAvailable,
} from './docker';
import { connectToServer, disconnectServer, discoverTools, disconnectAll, isConnected } from './client';
import { registerMcpTools, unregisterMcpTools, getMcpToolNames } from './bridge';
import type { McpToolInfo } from './types';

export const mcpEvents = new EventEmitter();
mcpEvents.setMaxListeners(50);

let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start an MCP server: pull image → start container → connect → discover tools → register.
 */
export async function startMcpServer(id: string): Promise<void> {
  const server = getMcpServer(id);
  if (!server) throw new Error(`MCP server ${id} not found`);

  if (server.status === 'running') {
    console.log(`[mcp] Server ${server.name} is already running`);
    return;
  }

  console.log(`[mcp] Starting MCP server: ${server.name} (${server.image})`);
  updateMcpServerStatus(id, 'starting');
  mcpEvents.emit('mcp:server:starting', { id, name: server.name });

  try {
    // 1. Pull image
    mcpEvents.emit('mcp:image:pulling', { id, name: server.name, image: server.image });
    try {
      await pullImage(server.image);
    } catch (err) {
      // Pull failure is not fatal — image may already be local
      console.log(`[mcp] Image pull warning for ${server.image}: ${err instanceof Error ? err.message : err}`);
    }

    // 2. Find free port for SSE transport
    let hostPort: number | undefined;
    if (server.transport === 'sse') {
      hostPort = await findFreePort();
    }

    // 3. Start Docker container
    const containerId = await startContainer(server, hostPort);
    updateMcpServerStatus(id, 'starting', { containerId, hostPort });

    // Wait a moment for the server to initialize
    await sleep(2000);

    // 4. Connect MCP client
    const updatedServer = getMcpServer(id)!;
    await connectToServer(updatedServer);

    // 5. Discover tools
    const tools = await discoverTools(id);
    updateMcpServerToolsCache(id, tools);

    // 6. Register tools in the ToolRegistry
    registerMcpTools(id, server.name, tools);

    // 7. Update status
    updateMcpServerStatus(id, 'running', { containerId, hostPort });

    console.log(`[mcp] Server ${server.name} started successfully with ${tools.length} tools`);
    mcpEvents.emit('mcp:server:started', { id, name: server.name, toolCount: tools.length });
    mcpEvents.emit('mcp:tools:discovered', {
      serverId: id,
      serverName: server.name,
      count: tools.length,
      tools: tools.map((t) => t.name),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mcp] Failed to start ${server.name}: ${msg}`);
    updateMcpServerStatus(id, 'error', { error: msg });
    mcpEvents.emit('mcp:server:error', { id, name: server.name, error: msg });

    // Clean up on failure
    const failedServer = getMcpServer(id);
    if (failedServer?.containerId) {
      try {
        await stopContainer(failedServer.containerId);
        await removeContainer(failedServer.containerId);
      } catch {
        // Ignore cleanup errors
      }
    }
    throw err;
  }
}

/**
 * Stop an MCP server: disconnect client → unregister tools → stop container.
 */
export async function stopMcpServer(id: string): Promise<void> {
  const server = getMcpServer(id);
  if (!server) throw new Error(`MCP server ${id} not found`);

  console.log(`[mcp] Stopping MCP server: ${server.name}`);

  // 1. Disconnect MCP client
  await disconnectServer(id);

  // 2. Unregister tools
  unregisterMcpTools(id);

  // 3. Stop and remove container
  if (server.containerId) {
    try {
      await stopContainer(server.containerId);
      await removeContainer(server.containerId);
    } catch (err) {
      console.warn(`[mcp] Container cleanup warning for ${server.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 4. Update status
  clearMcpServerRuntime(id);

  console.log(`[mcp] Server ${server.name} stopped`);
  mcpEvents.emit('mcp:server:stopped', { id, name: server.name });
}

/**
 * Restart an MCP server.
 */
export async function restartMcpServer(id: string): Promise<void> {
  await stopMcpServer(id);
  await startMcpServer(id);
}

/**
 * Get the tools for an MCP server (from cache or live discovery).
 */
export function getMcpServerTools(id: string): McpToolInfo[] {
  const server = getMcpServer(id);
  if (!server) return [];
  return server.toolsCache || [];
}

/**
 * Get the registered tool names for an MCP server.
 */
export function getRegisteredToolNames(id: string): string[] {
  return getMcpToolNames(id);
}

/**
 * Get container logs for an MCP server.
 */
export async function getMcpServerLogs(id: string, lines = 100): Promise<string> {
  const server = getMcpServer(id);
  if (!server?.containerId) return '';
  return getContainerLogs(server.containerId, lines);
}

/**
 * Initialize MCP servers on startup.
 * Restarts any servers that were previously running.
 */
export async function initMcpServers(): Promise<void> {
  const dockerAvailable = await checkDockerAvailable();
  if (!dockerAvailable) {
    console.log('[mcp] Docker not available — MCP server management disabled');
    return;
  }

  const servers = getAllMcpServers();
  const previouslyRunning = servers.filter((s) => s.status === 'running' || s.status === 'starting');

  if (previouslyRunning.length === 0) {
    console.log('[mcp] No MCP servers to restore');
    return;
  }

  console.log(`[mcp] Restoring ${previouslyRunning.length} MCP server(s)...`);

  for (const server of previouslyRunning) {
    // Reset status before attempting restart
    clearMcpServerRuntime(server.id);
    try {
      await startMcpServer(server.id);
    } catch (err) {
      console.error(`[mcp] Failed to restore ${server.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function runHealthCheck(): Promise<void> {
  const servers = getAllMcpServers().filter((s) => s.status === 'running');

  for (const server of servers) {
    try {
      // Check if container is still running
      if (server.containerId) {
        const running = await isContainerRunning(server.containerId);
        if (!running) {
          console.warn(`[mcp] Container for ${server.name} is not running — marking as error`);
          updateMcpServerStatus(server.id, 'error', { error: 'Container stopped unexpectedly' });
          unregisterMcpTools(server.id);
          await disconnectServer(server.id);
          mcpEvents.emit('mcp:server:error', {
            id: server.id,
            name: server.name,
            error: 'Container stopped unexpectedly',
          });
          continue;
        }
      }

      // Check if MCP client is still connected
      if (!isConnected(server.id)) {
        console.warn(`[mcp] Client disconnected from ${server.name} — attempting reconnect`);
        try {
          await connectToServer(server);
          const tools = await discoverTools(server.id);
          updateMcpServerToolsCache(server.id, tools);
          registerMcpTools(server.id, server.name, tools);
          console.log(`[mcp] Reconnected to ${server.name}`);
        } catch {
          console.error(`[mcp] Reconnect failed for ${server.name}`);
          updateMcpServerStatus(server.id, 'error', { error: 'Reconnection failed' });
          mcpEvents.emit('mcp:server:error', {
            id: server.id,
            name: server.name,
            error: 'Reconnection failed',
          });
        }
      }
    } catch (err) {
      console.error(`[mcp] Health check error for ${server.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Start the health check interval.
 * Monitors running MCP servers and attempts reconnection on failure.
 */
export function startHealthCheck(): void {
  if (healthCheckInterval) return;

  healthCheckInterval = setInterval(() => {
    void runHealthCheck();
  }, 60_000);

  console.log('[mcp] Health check started (60s interval)');
}

/**
 * Stop the health check interval.
 */
export function stopHealthCheck(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

/**
 * Graceful shutdown: stop all MCP servers and clean up.
 */
export async function shutdownAllMcpServers(): Promise<void> {
  stopHealthCheck();

  const servers = getAllMcpServers().filter((s) => s.status === 'running' || s.status === 'starting');
  console.log(`[mcp] Shutting down ${servers.length} MCP server(s)...`);

  for (const server of servers) {
    try {
      await stopMcpServer(server.id);
    } catch (err) {
      console.error(`[mcp] Shutdown error for ${server.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  await disconnectAll();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
