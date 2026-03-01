/**
 * MCP Server Module
 *
 * Docker-based MCP (Model Context Protocol) server management.
 * Provides pre-built tool servers as Docker containers that agents
 * can use via the standard tool interface.
 */

// Types
export type {
  McpServerConfig,
  McpToolInfo,
  McpTransport,
  McpServerStatus,
  CatalogEntry,
  EnvVarSchema,
  CreateMcpServerInput,
  UpdateMcpServerInput,
} from './types';

// Database
export {
  initMcpSchema,
  createMcpServer,
  getMcpServer,
  getAllMcpServers,
  updateMcpServer,
  deleteMcpServer,
  updateMcpServerStatus,
  assignMcpServerToGroup,
  unassignMcpServerFromGroup,
  getMcpServerGroupIds,
  getMcpServersByGroup,
  getMcpToolNamesForGroup,
} from './db';

// Catalog
export { getCatalog, getCatalogEntry } from './catalog';

// Manager (orchestration)
export {
  mcpEvents,
  startMcpServer,
  stopMcpServer,
  restartMcpServer,
  getMcpServerTools,
  getRegisteredToolNames,
  getMcpServerLogs,
  initMcpServers,
  startHealthCheck,
  stopHealthCheck,
  shutdownAllMcpServers,
} from './manager';

// Bridge
export { getAllMcpToolNames } from './bridge';

// Client
export { getActiveConnectionCount } from './client';
