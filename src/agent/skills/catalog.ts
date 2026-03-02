/**
 * Skill Catalog - Registry of known skills that can be auto-discovered and installed.
 *
 * The catalog contains metadata for skills that aren't built-in but can be
 * activated on demand when the agent detects it needs one.
 * Each entry includes a manifest template and a handler generator.
 */

import { SkillManifest } from './schema';

export interface CatalogEntry {
  /** Unique skill name */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** What this skill does */
  description: string;
  /** Categories / tags for matching */
  tags: string[];
  /** Keywords that trigger discovery (matched against user messages) */
  keywords: string[];
  /** The skill manifest to install */
  manifest: SkillManifest;
  /** The handler.js source code */
  handlerSource: string;
  /** Whether this skill requires environment variables */
  requiredEnvVars?: string[];
  /** Setup instructions shown after approval */
  setupHint?: string;
}

/**
 * The skill catalog - known skills that the agent can suggest activating.
 * Each entry is a complete, installable skill definition.
 */
export const SKILL_CATALOG: CatalogEntry[] = [
  {
    name: 'postgresql_query',
    displayName: 'PostgreSQL',
    description: 'Execute SQL queries against a PostgreSQL database. Supports SELECT, INSERT, UPDATE, DELETE and DDL statements.',
    tags: ['database', 'sql', 'postgresql', 'postgres'],
    keywords: ['database', 'datenbank', 'sql', 'postgresql', 'postgres', 'tabelle', 'table', 'query', 'abfrage', 'SELECT', 'INSERT', 'schema'],
    manifest: {
      name: 'postgresql_query',
      description: 'Execute SQL queries against a PostgreSQL database. Connects using DATABASE_URL or individual PG* environment variables.',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The SQL query to execute' },
          params: { type: 'string', description: 'JSON array of query parameters for parameterized queries (prevents SQL injection)' },
          database_url: { type: 'string', description: 'PostgreSQL connection string (optional, falls back to DATABASE_URL env var)' },
        },
        required: ['query'],
      },
      handler: './handler.js',
      containerCompatible: true,
    },
    handlerSource: `const { Client } = require('pg');

module.exports = {
  async execute(input) {
    const connectionString = input.database_url || process.env.DATABASE_URL;
    if (!connectionString) {
      return { content: 'Error: No database connection configured. Set DATABASE_URL environment variable or pass database_url parameter.', isError: true };
    }
    const client = new Client({ connectionString });
    try {
      await client.connect();
      const params = input.params ? JSON.parse(input.params) : [];
      const result = await client.query(input.query, params);
      const output = {
        command: result.command,
        rowCount: result.rowCount,
        rows: result.rows ? result.rows.slice(0, 100) : [],
        fields: result.fields ? result.fields.map(f => f.name) : [],
      };
      if (result.rows && result.rows.length > 100) {
        output.truncated = true;
        output.totalRows = result.rows.length;
      }
      return { content: JSON.stringify(output, null, 2) };
    } catch (err) {
      return { content: 'SQL Error: ' + (err.message || String(err)), isError: true };
    } finally {
      await client.end().catch(() => {});
    }
  }
};
`,
    requiredEnvVars: ['DATABASE_URL'],
    setupHint: 'Set DATABASE_URL in your .env file (e.g. postgresql://user:pass@localhost:5432/dbname). Ensure the pg npm package is installed.',
  },

  {
    name: 'redis_command',
    displayName: 'Redis',
    description: 'Execute commands against a Redis server. Supports GET, SET, HGET, LPUSH, and all standard Redis commands.',
    tags: ['database', 'cache', 'redis', 'key-value'],
    keywords: ['redis', 'cache', 'key-value', 'schlüssel', 'memcached', 'session', 'pub/sub'],
    manifest: {
      name: 'redis_command',
      description: 'Execute Redis commands. Connects using REDIS_URL environment variable.',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Redis command (e.g. GET, SET, HGETALL, LPUSH)' },
          args: { type: 'string', description: 'JSON array of command arguments' },
          redis_url: { type: 'string', description: 'Redis connection URL (optional, falls back to REDIS_URL env var)' },
        },
        required: ['command'],
      },
      handler: './handler.js',
      containerCompatible: true,
    },
    handlerSource: `const { createClient } = require('redis');

module.exports = {
  async execute(input) {
    const url = input.redis_url || process.env.REDIS_URL || 'redis://localhost:6379';
    const client = createClient({ url });
    try {
      await client.connect();
      const args = input.args ? JSON.parse(input.args) : [];
      const result = await client.sendCommand([input.command.toUpperCase(), ...args]);
      return { content: JSON.stringify(result, null, 2) };
    } catch (err) {
      return { content: 'Redis Error: ' + (err.message || String(err)), isError: true };
    } finally {
      await client.disconnect().catch(() => {});
    }
  }
};
`,
    requiredEnvVars: ['REDIS_URL'],
    setupHint: 'Set REDIS_URL in your .env file (e.g. redis://localhost:6379). Ensure the redis npm package is installed.',
  },

  {
    name: 'mongodb_query',
    displayName: 'MongoDB',
    description: 'Query and manipulate MongoDB collections. Supports find, insertOne, updateMany, aggregate, and other common operations.',
    tags: ['database', 'nosql', 'mongodb', 'document'],
    keywords: ['mongodb', 'mongo', 'nosql', 'document', 'collection', 'dokument', 'aggregation'],
    manifest: {
      name: 'mongodb_query',
      description: 'Execute MongoDB operations. Connects using MONGODB_URI environment variable.',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          database: { type: 'string', description: 'Database name' },
          collection: { type: 'string', description: 'Collection name' },
          operation: { type: 'string', description: 'Operation: find, findOne, insertOne, insertMany, updateOne, updateMany, deleteOne, deleteMany, aggregate, countDocuments', enum: ['find', 'findOne', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'aggregate', 'countDocuments'] },
          query: { type: 'string', description: 'JSON query/filter object' },
          data: { type: 'string', description: 'JSON data for insert/update operations' },
          options: { type: 'string', description: 'JSON options (e.g. sort, limit, projection)' },
          mongodb_uri: { type: 'string', description: 'MongoDB connection URI (optional, falls back to MONGODB_URI env var)' },
        },
        required: ['database', 'collection', 'operation'],
      },
      handler: './handler.js',
      containerCompatible: true,
    },
    handlerSource: `const { MongoClient } = require('mongodb');

module.exports = {
  async execute(input) {
    const uri = input.mongodb_uri || process.env.MONGODB_URI;
    if (!uri) {
      return { content: 'Error: No MongoDB connection configured. Set MONGODB_URI environment variable.', isError: true };
    }
    const client = new MongoClient(uri);
    try {
      await client.connect();
      const db = client.db(input.database);
      const col = db.collection(input.collection);
      const query = input.query ? JSON.parse(input.query) : {};
      const data = input.data ? JSON.parse(input.data) : {};
      const options = input.options ? JSON.parse(input.options) : {};
      let result;
      switch (input.operation) {
        case 'find': result = await col.find(query, options).limit(options.limit || 100).toArray(); break;
        case 'findOne': result = await col.findOne(query, options); break;
        case 'insertOne': result = await col.insertOne(data); break;
        case 'insertMany': result = await col.insertMany(Array.isArray(data) ? data : [data]); break;
        case 'updateOne': result = await col.updateOne(query, data, options); break;
        case 'updateMany': result = await col.updateMany(query, data, options); break;
        case 'deleteOne': result = await col.deleteOne(query); break;
        case 'deleteMany': result = await col.deleteMany(query); break;
        case 'aggregate': result = await col.aggregate(Array.isArray(query) ? query : [query]).toArray(); break;
        case 'countDocuments': result = await col.countDocuments(query); break;
        default: return { content: 'Unknown operation: ' + input.operation, isError: true };
      }
      return { content: JSON.stringify(result, null, 2) };
    } catch (err) {
      return { content: 'MongoDB Error: ' + (err.message || String(err)), isError: true };
    } finally {
      await client.close().catch(() => {});
    }
  }
};
`,
    requiredEnvVars: ['MONGODB_URI'],
    setupHint: 'Set MONGODB_URI in your .env file (e.g. mongodb://localhost:27017). Ensure the mongodb npm package is installed.',
  },

  {
    name: 'slack_message',
    displayName: 'Slack',
    description: 'Send messages, read channels, and interact with Slack workspaces via the Slack Web API.',
    tags: ['messaging', 'slack', 'communication', 'chat'],
    keywords: ['slack', 'channel', 'nachricht', 'message', 'workspace', 'team', 'benachrichtigung', 'notification'],
    manifest: {
      name: 'slack_message',
      description: 'Interact with Slack: send messages, list channels, read history. Requires SLACK_BOT_TOKEN environment variable.',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action to perform', enum: ['send_message', 'list_channels', 'read_history', 'add_reaction'] },
          channel: { type: 'string', description: 'Channel ID or name (for send_message, read_history)' },
          text: { type: 'string', description: 'Message text (for send_message)' },
          count: { type: 'number', description: 'Number of messages to retrieve (for read_history, default 10)' },
          timestamp: { type: 'string', description: 'Message timestamp (for add_reaction)' },
          emoji: { type: 'string', description: 'Emoji name without colons (for add_reaction)' },
        },
        required: ['action'],
      },
      handler: './handler.js',
      containerCompatible: true,
    },
    handlerSource: `module.exports = {
  async execute(input) {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      return { content: 'Error: SLACK_BOT_TOKEN environment variable is not set.', isError: true };
    }
    const base = 'https://slack.com/api';
    const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
    try {
      let url, body;
      switch (input.action) {
        case 'send_message':
          url = base + '/chat.postMessage';
          body = JSON.stringify({ channel: input.channel, text: input.text });
          break;
        case 'list_channels':
          url = base + '/conversations.list?types=public_channel,private_channel&limit=100';
          body = null;
          break;
        case 'read_history':
          url = base + '/conversations.history?channel=' + input.channel + '&limit=' + (input.count || 10);
          body = null;
          break;
        case 'add_reaction':
          url = base + '/reactions.add';
          body = JSON.stringify({ channel: input.channel, timestamp: input.timestamp, name: input.emoji });
          break;
        default:
          return { content: 'Unknown action: ' + input.action, isError: true };
      }
      const resp = await fetch(url, { method: body ? 'POST' : 'GET', headers, ...(body ? { body } : {}) });
      const data = await resp.json();
      if (!data.ok) return { content: 'Slack API Error: ' + (data.error || JSON.stringify(data)), isError: true };
      return { content: JSON.stringify(data, null, 2) };
    } catch (err) {
      return { content: 'Slack Error: ' + (err.message || String(err)), isError: true };
    }
  }
};
`,
    requiredEnvVars: ['SLACK_BOT_TOKEN'],
    setupHint: 'Set SLACK_BOT_TOKEN in your .env file. Create a Slack app at https://api.slack.com/apps with the required scopes.',
  },

  {
    name: 's3_storage',
    displayName: 'S3 / Object Storage',
    description: 'Interact with AWS S3 or S3-compatible object storage. List buckets, upload/download objects, generate presigned URLs.',
    tags: ['storage', 'aws', 's3', 'cloud', 'files'],
    keywords: ['s3', 'aws', 'bucket', 'storage', 'speicher', 'upload', 'download', 'object', 'datei', 'file', 'cloud'],
    manifest: {
      name: 's3_storage',
      description: 'Interact with S3-compatible object storage. Requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action to perform', enum: ['list_buckets', 'list_objects', 'get_object', 'put_object', 'delete_object'] },
          bucket: { type: 'string', description: 'Bucket name' },
          key: { type: 'string', description: 'Object key/path' },
          content: { type: 'string', description: 'Content to upload (for put_object)' },
          prefix: { type: 'string', description: 'Key prefix filter (for list_objects)' },
          region: { type: 'string', description: 'AWS region (default: us-east-1)' },
          endpoint: { type: 'string', description: 'Custom S3 endpoint URL (for MinIO, DigitalOcean Spaces, etc.)' },
        },
        required: ['action'],
      },
      handler: './handler.js',
      containerCompatible: true,
    },
    handlerSource: `const { S3Client, ListBucketsCommand, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

module.exports = {
  async execute(input) {
    const config = {
      region: input.region || process.env.AWS_REGION || 'us-east-1',
    };
    if (input.endpoint) config.endpoint = input.endpoint;
    const s3 = new S3Client(config);
    try {
      let result;
      switch (input.action) {
        case 'list_buckets':
          result = await s3.send(new ListBucketsCommand({}));
          return { content: JSON.stringify(result.Buckets, null, 2) };
        case 'list_objects':
          result = await s3.send(new ListObjectsV2Command({ Bucket: input.bucket, Prefix: input.prefix || '' }));
          return { content: JSON.stringify((result.Contents || []).map(o => ({ Key: o.Key, Size: o.Size, LastModified: o.LastModified })), null, 2) };
        case 'get_object':
          result = await s3.send(new GetObjectCommand({ Bucket: input.bucket, Key: input.key }));
          const body = await result.Body.transformToString();
          return { content: body.slice(0, 50000) };
        case 'put_object':
          await s3.send(new PutObjectCommand({ Bucket: input.bucket, Key: input.key, Body: input.content }));
          return { content: JSON.stringify({ status: 'uploaded', bucket: input.bucket, key: input.key }) };
        case 'delete_object':
          await s3.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }));
          return { content: JSON.stringify({ status: 'deleted', bucket: input.bucket, key: input.key }) };
        default:
          return { content: 'Unknown action: ' + input.action, isError: true };
      }
    } catch (err) {
      return { content: 'S3 Error: ' + (err.message || String(err)), isError: true };
    }
  }
};
`,
    requiredEnvVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    setupHint: 'Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in your .env file. Install @aws-sdk/client-s3.',
  },

  {
    name: 'jira_issue',
    displayName: 'Jira',
    description: 'Interact with Jira: create issues, search with JQL, update status, add comments.',
    tags: ['project-management', 'jira', 'tickets', 'issues'],
    keywords: ['jira', 'ticket', 'issue', 'sprint', 'kanban', 'aufgabe', 'task', 'project', 'projekt', 'backlog', 'story'],
    manifest: {
      name: 'jira_issue',
      description: 'Interact with Jira Cloud or Server. Requires JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN.',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action to perform', enum: ['search', 'get_issue', 'create_issue', 'update_issue', 'add_comment', 'transition'] },
          jql: { type: 'string', description: 'JQL query string (for search)' },
          issue_key: { type: 'string', description: 'Issue key like PROJ-123' },
          project: { type: 'string', description: 'Project key (for create_issue)' },
          summary: { type: 'string', description: 'Issue summary/title' },
          description: { type: 'string', description: 'Issue description' },
          issue_type: { type: 'string', description: 'Issue type (e.g. Task, Bug, Story)' },
          comment: { type: 'string', description: 'Comment text (for add_comment)' },
          transition_id: { type: 'string', description: 'Transition ID (for transition)' },
          fields: { type: 'string', description: 'JSON object with additional fields to set' },
        },
        required: ['action'],
      },
      handler: './handler.js',
      containerCompatible: true,
    },
    handlerSource: `module.exports = {
  async execute(input) {
    const baseUrl = process.env.JIRA_BASE_URL;
    const email = process.env.JIRA_EMAIL;
    const token = process.env.JIRA_API_TOKEN;
    if (!baseUrl || !email || !token) {
      return { content: 'Error: Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN environment variables.', isError: true };
    }
    const auth = Buffer.from(email + ':' + token).toString('base64');
    const headers = { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json', 'Accept': 'application/json' };
    const api = baseUrl.replace(/\\/$/, '') + '/rest/api/3';
    try {
      let resp, data;
      switch (input.action) {
        case 'search':
          resp = await fetch(api + '/search?jql=' + encodeURIComponent(input.jql || '') + '&maxResults=20', { headers });
          data = await resp.json();
          return { content: JSON.stringify((data.issues || []).map(i => ({ key: i.key, summary: i.fields.summary, status: i.fields.status?.name, assignee: i.fields.assignee?.displayName })), null, 2) };
        case 'get_issue':
          resp = await fetch(api + '/issue/' + input.issue_key, { headers });
          data = await resp.json();
          return { content: JSON.stringify({ key: data.key, summary: data.fields?.summary, description: data.fields?.description, status: data.fields?.status?.name, assignee: data.fields?.assignee?.displayName, priority: data.fields?.priority?.name }, null, 2) };
        case 'create_issue':
          const fields = input.fields ? JSON.parse(input.fields) : {};
          resp = await fetch(api + '/issue', { method: 'POST', headers, body: JSON.stringify({ fields: { project: { key: input.project }, summary: input.summary, description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: input.description || '' }] }] }, issuetype: { name: input.issue_type || 'Task' }, ...fields } }) });
          data = await resp.json();
          return { content: JSON.stringify({ key: data.key, self: data.self }) };
        case 'update_issue':
          const updateFields = input.fields ? JSON.parse(input.fields) : {};
          if (input.summary) updateFields.summary = input.summary;
          resp = await fetch(api + '/issue/' + input.issue_key, { method: 'PUT', headers, body: JSON.stringify({ fields: updateFields }) });
          return { content: resp.ok ? JSON.stringify({ status: 'updated', key: input.issue_key }) : 'Error: ' + (await resp.text()) };
        case 'add_comment':
          resp = await fetch(api + '/issue/' + input.issue_key + '/comment', { method: 'POST', headers, body: JSON.stringify({ body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: input.comment }] }] } }) });
          data = await resp.json();
          return { content: JSON.stringify({ id: data.id, created: data.created }) };
        case 'transition':
          resp = await fetch(api + '/issue/' + input.issue_key + '/transitions', { method: 'POST', headers, body: JSON.stringify({ transition: { id: input.transition_id } }) });
          return { content: resp.ok ? JSON.stringify({ status: 'transitioned', key: input.issue_key }) : 'Error: ' + (await resp.text()) };
        default:
          return { content: 'Unknown action: ' + input.action, isError: true };
      }
    } catch (err) {
      return { content: 'Jira Error: ' + (err.message || String(err)), isError: true };
    }
  }
};
`,
    requiredEnvVars: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'],
    setupHint: 'Set JIRA_BASE_URL (e.g. https://yourcompany.atlassian.net), JIRA_EMAIL, and JIRA_API_TOKEN in your .env file.',
  },

  {
    name: 'csv_processor',
    displayName: 'CSV Processor',
    description: 'Parse, transform, filter, and analyze CSV data. Supports reading CSV files, applying filters, computing aggregations, and generating output.',
    tags: ['data', 'csv', 'spreadsheet', 'analysis'],
    keywords: ['csv', 'tabelle', 'spreadsheet', 'daten', 'data', 'parse', 'excel', 'analyse', 'analysis', 'spalte', 'column'],
    manifest: {
      name: 'csv_processor',
      description: 'Process and analyze CSV data. Read files, filter rows, compute aggregations, and transform data.',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action to perform', enum: ['parse', 'filter', 'aggregate', 'transform'] },
          file_path: { type: 'string', description: 'Path to CSV file (for parse)' },
          csv_data: { type: 'string', description: 'Raw CSV data as string' },
          delimiter: { type: 'string', description: 'Column delimiter (default: ,)' },
          filter_column: { type: 'string', description: 'Column name to filter on' },
          filter_value: { type: 'string', description: 'Value to filter for' },
          agg_column: { type: 'string', description: 'Column to aggregate' },
          agg_function: { type: 'string', description: 'Aggregation: sum, avg, min, max, count', enum: ['sum', 'avg', 'min', 'max', 'count'] },
          group_by: { type: 'string', description: 'Column to group by for aggregation' },
          limit: { type: 'number', description: 'Max rows to return (default: 100)' },
        },
        required: ['action'],
      },
      handler: './handler.js',
      containerCompatible: true,
    },
    handlerSource: `const fs = require('fs');

function parseCSV(text, delimiter = ',') {
  const lines = text.trim().split('\\n');
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split(delimiter).map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(delimiter).map(v => v.trim().replace(/^"|"$/g, ''));
    const row = {};
    headers.forEach((h, j) => { row[h] = values[j] || ''; });
    rows.push(row);
  }
  return { headers, rows };
}

module.exports = {
  async execute(input) {
    try {
      let csvText = input.csv_data;
      if (!csvText && input.file_path) {
        csvText = fs.readFileSync(input.file_path, 'utf-8');
      }
      if (!csvText) return { content: 'Error: Provide csv_data or file_path', isError: true };
      const { headers, rows } = parseCSV(csvText, input.delimiter);
      const limit = input.limit || 100;
      switch (input.action) {
        case 'parse':
          return { content: JSON.stringify({ headers, rowCount: rows.length, rows: rows.slice(0, limit) }, null, 2) };
        case 'filter':
          const filtered = rows.filter(r => r[input.filter_column] === input.filter_value);
          return { content: JSON.stringify({ headers, matchCount: filtered.length, rows: filtered.slice(0, limit) }, null, 2) };
        case 'aggregate': {
          const values = rows.map(r => parseFloat(r[input.agg_column])).filter(v => !isNaN(v));
          let result;
          switch (input.agg_function) {
            case 'sum': result = values.reduce((a, b) => a + b, 0); break;
            case 'avg': result = values.reduce((a, b) => a + b, 0) / values.length; break;
            case 'min': result = Math.min(...values); break;
            case 'max': result = Math.max(...values); break;
            case 'count': result = values.length; break;
          }
          return { content: JSON.stringify({ column: input.agg_column, function: input.agg_function, result }, null, 2) };
        }
        default:
          return { content: 'Unknown action: ' + input.action, isError: true };
      }
    } catch (err) {
      return { content: 'CSV Error: ' + (err.message || String(err)), isError: true };
    }
  }
};
`,
    setupHint: 'No additional setup required. This skill processes CSV data directly.',
  },

  {
    name: 'docker_manage',
    displayName: 'Docker',
    description: 'Manage Docker containers, images, and volumes. List, start, stop, and inspect containers.',
    tags: ['devops', 'docker', 'containers', 'infrastructure'],
    keywords: ['docker', 'container', 'image', 'volume', 'devops', 'deploy', 'bereitstellung'],
    manifest: {
      name: 'docker_manage',
      description: 'Manage Docker containers and images via the Docker CLI. Requires Docker to be installed and accessible.',
      version: '1.0.0',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action to perform', enum: ['ps', 'images', 'logs', 'inspect', 'start', 'stop', 'restart', 'stats'] },
          container: { type: 'string', description: 'Container name or ID' },
          tail: { type: 'number', description: 'Number of log lines (for logs, default: 50)' },
        },
        required: ['action'],
      },
      handler: './handler.js',
      containerCompatible: false,
    },
    handlerSource: `const { execSync } = require('child_process');

module.exports = {
  async execute(input) {
    try {
      let cmd;
      switch (input.action) {
        case 'ps': cmd = 'docker ps --format "table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}"'; break;
        case 'images': cmd = 'docker images --format "table {{.Repository}}\\t{{.Tag}}\\t{{.Size}}\\t{{.CreatedSince}}"'; break;
        case 'logs': cmd = 'docker logs --tail ' + (input.tail || 50) + ' ' + input.container; break;
        case 'inspect': cmd = 'docker inspect ' + input.container; break;
        case 'start': cmd = 'docker start ' + input.container; break;
        case 'stop': cmd = 'docker stop ' + input.container; break;
        case 'restart': cmd = 'docker restart ' + input.container; break;
        case 'stats': cmd = 'docker stats --no-stream --format "table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}"'; break;
        default: return { content: 'Unknown action: ' + input.action, isError: true };
      }
      const result = execSync(cmd, { encoding: 'utf-8', timeout: 15000 });
      return { content: result };
    } catch (err) {
      return { content: 'Docker Error: ' + (err.message || String(err)), isError: true };
    }
  }
};
`,
    setupHint: 'Ensure Docker is installed and the gateway process has access to the Docker socket.',
  },
];

/**
 * Get all catalog entries.
 */
export function getCatalog(): CatalogEntry[] {
  return SKILL_CATALOG;
}

/**
 * Get a catalog entry by name.
 */
export function getCatalogEntry(name: string): CatalogEntry | undefined {
  return SKILL_CATALOG.find((e) => e.name === name);
}

/**
 * Get catalog entries that are not currently installed.
 * Compares against the list of currently loaded skill names.
 */
export function getAvailableCatalogEntries(installedSkillNames: string[]): CatalogEntry[] {
  return SKILL_CATALOG.filter((e) => !installedSkillNames.includes(e.name));
}

/**
 * Search catalog entries by keywords, tags, or description matching.
 * Returns entries sorted by relevance score.
 */
export function searchCatalog(query: string, installedSkillNames: string[]): CatalogEntry[] {
  const terms = query.toLowerCase().split(/\s+/);
  const available = getAvailableCatalogEntries(installedSkillNames);

  const scored = available.map((entry) => {
    let score = 0;
    for (const term of terms) {
      // Keyword match (highest weight)
      if (entry.keywords.some((k) => k.toLowerCase().includes(term))) score += 3;
      // Tag match
      if (entry.tags.some((t) => t.toLowerCase().includes(term))) score += 2;
      // Description match
      if (entry.description.toLowerCase().includes(term)) score += 1;
      // Name match
      if (entry.name.toLowerCase().includes(term)) score += 2;
    }
    return { entry, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.entry);
}
