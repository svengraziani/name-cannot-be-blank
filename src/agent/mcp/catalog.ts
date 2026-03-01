/**
 * MCP Server Catalog
 *
 * Pre-defined catalog of popular MCP servers with their Docker images,
 * configuration schemas, and default settings.
 */

import type { CatalogEntry } from './types';

export const MCP_CATALOG: CatalogEntry[] = [
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Query and manage PostgreSQL databases. Execute SQL, inspect schema, and manage data.',
    icon: 'database',
    image: 'mcp/postgres',
    transport: 'stdio',
    envSchema: [
      { key: 'POSTGRES_HOST', label: 'Host', required: true, default: 'host.docker.internal' },
      { key: 'POSTGRES_PORT', label: 'Port', required: false, default: '5432', type: 'number' },
      { key: 'POSTGRES_DB', label: 'Database', required: true },
      { key: 'POSTGRES_USER', label: 'User', required: true, default: 'postgres' },
      { key: 'POSTGRES_PASSWORD', label: 'Password', required: true, secret: true },
    ],
    documentation: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Read and query SQLite databases. Execute SQL statements and inspect schema.',
    icon: 'database',
    image: 'mcp/sqlite',
    transport: 'stdio',
    args: ['--db-path', '/data/database.db'],
    envSchema: [],
    defaultVolumes: ['/data/sqlite:/data'],
    documentation: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, write, and manage files on the host filesystem. Search, create directories, move files.',
    icon: 'folder',
    image: 'mcp/filesystem',
    transport: 'stdio',
    args: ['/data'],
    envSchema: [],
    defaultVolumes: ['/data/files:/data'],
    documentation: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Manage GitHub repositories, issues, pull requests, and files via the GitHub API.',
    icon: 'git-branch',
    image: 'mcp/github',
    transport: 'stdio',
    envSchema: [
      { key: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'Personal Access Token', required: true, secret: true, description: 'GitHub PAT with repo access' },
    ],
    documentation: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Send messages, read channels, manage conversations, and search in Slack workspaces.',
    icon: 'message-square',
    image: 'mcp/slack',
    transport: 'stdio',
    envSchema: [
      { key: 'SLACK_BOT_TOKEN', label: 'Bot Token', required: true, secret: true, description: 'Slack Bot User OAuth Token (xoxb-...)' },
      { key: 'SLACK_TEAM_ID', label: 'Team ID', required: false, description: 'Slack workspace Team ID' },
    ],
    documentation: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web and local search using the Brave Search API. Find information, news, and local businesses.',
    icon: 'search',
    image: 'mcp/brave-search',
    transport: 'stdio',
    envSchema: [
      { key: 'BRAVE_API_KEY', label: 'API Key', required: true, secret: true, description: 'Brave Search API key from brave.com/search/api' },
    ],
    documentation: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
  },
  {
    id: 'google-maps',
    name: 'Google Maps',
    description: 'Geocoding, directions, place search, and distance calculations via Google Maps API.',
    icon: 'map-pin',
    image: 'mcp/google-maps',
    transport: 'stdio',
    envSchema: [
      { key: 'GOOGLE_MAPS_API_KEY', label: 'API Key', required: true, secret: true, description: 'Google Maps Platform API key' },
    ],
    documentation: 'https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps',
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: 'Browser automation — navigate pages, take screenshots, click elements, fill forms, extract content.',
    icon: 'globe',
    image: 'mcp/puppeteer',
    transport: 'stdio',
    envSchema: [],
    documentation: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Persistent knowledge graph for storing and retrieving entities, relations, and observations.',
    icon: 'brain',
    image: 'mcp/memory',
    transport: 'stdio',
    envSchema: [],
    defaultVolumes: ['/data/memory:/data'],
    documentation: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
];

/**
 * Get the full catalog.
 */
export function getCatalog(): CatalogEntry[] {
  return MCP_CATALOG;
}

/**
 * Find a catalog entry by ID.
 */
export function getCatalogEntry(id: string): CatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.id === id);
}
