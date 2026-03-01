/**
 * MCP Server Types
 *
 * Type definitions for the Docker MCP Server integration.
 * MCP servers run as Docker containers and expose tools via the Model Context Protocol.
 */

export type McpTransport = 'stdio' | 'sse';
export type McpServerStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface McpServerConfig {
  id: string;
  name: string;
  description: string;
  image: string;
  transport: McpTransport;
  port?: number;
  command?: string;
  args: string[];
  env: Record<string, string>;
  volumes: string[];
  status: McpServerStatus;
  containerId?: string;
  hostPort?: number;
  toolsCache?: McpToolInfo[];
  catalogId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  icon: string;
  image: string;
  transport: McpTransport;
  defaultPort?: number;
  command?: string;
  args?: string[];
  envSchema: EnvVarSchema[];
  defaultVolumes?: string[];
  documentation?: string;
}

export interface EnvVarSchema {
  key: string;
  label: string;
  description?: string;
  required: boolean;
  default?: string;
  secret?: boolean;
  type?: 'string' | 'number' | 'boolean';
}

export interface CreateMcpServerInput {
  name: string;
  description?: string;
  image: string;
  transport?: McpTransport;
  port?: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  volumes?: string[];
  catalogId?: string;
}

export interface UpdateMcpServerInput {
  name?: string;
  description?: string;
  image?: string;
  transport?: McpTransport;
  port?: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  volumes?: string[];
}
