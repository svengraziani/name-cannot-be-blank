/**
 * OpenAPI 3.0 specification for Loop Gateway REST API.
 */

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Loop Gateway API',
    version: '1.0.0',
    description:
      'Agentic AI loop gateway with multi-channel messaging, container isolation, autonomous task execution, and real-time dashboard.',
  },
  servers: [{ url: '/api', description: 'API base path' }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http' as const,
        scheme: 'bearer',
        description: 'Session token obtained via /api/auth/login',
      },
    },
    schemas: {
      Error: {
        type: 'object' as const,
        properties: {
          error: { type: 'string' as const },
        },
      },
      Channel: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          type: { type: 'string' as const, enum: ['telegram', 'whatsapp', 'email', 'mattermost'] },
          name: { type: 'string' as const },
          enabled: { type: 'boolean' as const },
          status: { type: 'string' as const, enum: ['disconnected', 'connecting', 'connected', 'error'] },
          statusInfo: { type: 'object' as const },
          agentGroupId: { type: 'string' as const, nullable: true },
        },
      },
      ChannelHealth: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          type: { type: 'string' as const },
          name: { type: 'string' as const },
          enabled: { type: 'boolean' as const },
          health: {
            type: 'object' as const,
            properties: {
              status: { type: 'string' as const, enum: ['disconnected', 'connecting', 'connected', 'error', 'disabled'] },
              connected: { type: 'boolean' as const },
              error: { type: 'string' as const, nullable: true },
              details: {
                type: 'object' as const,
                description: 'Channel-type-specific health details (e.g. imapAlive, qrCodeRequired, botConnected)',
              },
            },
          },
        },
      },
      HealthResponse: {
        type: 'object' as const,
        properties: {
          status: { type: 'string' as const, enum: ['ok', 'degraded'] },
          uptime: { type: 'number' as const, description: 'Uptime in seconds' },
          containerMode: { type: 'boolean' as const },
          channels: {
            type: 'object' as const,
            properties: {
              total: { type: 'integer' as const },
              enabled: { type: 'integer' as const },
              connected: { type: 'integer' as const },
            },
          },
        },
      },
      AgentGroup: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          name: { type: 'string' as const },
          description: { type: 'string' as const },
          systemPrompt: { type: 'string' as const },
          model: { type: 'string' as const },
          maxTokens: { type: 'integer' as const },
          hasApiKey: { type: 'boolean' as const },
          hasGithubToken: { type: 'boolean' as const },
        },
      },
      Skill: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const },
          description: { type: 'string' as const },
          version: { type: 'string' as const },
          enabled: { type: 'boolean' as const },
          builtin: { type: 'boolean' as const },
        },
      },
      ApprovalRequest: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          runId: { type: 'integer' as const },
          conversationId: { type: 'string' as const },
          toolName: { type: 'string' as const },
          riskLevel: { type: 'string' as const, enum: ['low', 'medium', 'high', 'critical'] },
          status: { type: 'string' as const, enum: ['pending', 'approved', 'rejected', 'timeout'] },
        },
      },
      SchedulerJob: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, format: 'uuid' },
          name: { type: 'string' as const },
          enabled: { type: 'boolean' as const },
          trigger: { type: 'object' as const },
          action: { type: 'object' as const },
          output: { type: 'object' as const },
          triggerDescription: { type: 'string' as const },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    // --- Auth ---
    '/auth/status': {
      get: {
        tags: ['Auth'],
        summary: 'Check if initial setup is required',
        security: [],
        responses: {
          '200': {
            description: 'Setup status',
            content: { 'application/json': { schema: { type: 'object', properties: { setupRequired: { type: 'boolean' } } } } },
          },
        },
      },
    },
    '/auth/setup': {
      post: {
        tags: ['Auth'],
        summary: 'Create the initial admin account',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: { username: { type: 'string' }, password: { type: 'string', minLength: 8 } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Admin created, returns session token' },
          '400': { description: 'Validation error or admin already exists' },
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Login with username and password',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: { username: { type: 'string' }, password: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Login successful',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { token: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' } } },
              },
            },
          },
          '401': { description: 'Invalid credentials' },
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Invalidate the current session',
        responses: { '200': { description: 'Logged out' } },
      },
    },

    // --- Channels ---
    '/channels': {
      get: {
        tags: ['Channels'],
        summary: 'List all channels with status',
        responses: {
          '200': {
            description: 'Channel list',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Channel' } } } },
          },
        },
      },
      post: {
        tags: ['Channels'],
        summary: 'Create a new channel',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['type', 'name'],
                properties: {
                  type: { type: 'string', enum: ['telegram', 'whatsapp', 'email', 'mattermost'] },
                  name: { type: 'string' },
                  config: { type: 'object', description: 'Channel-specific configuration' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Channel created' },
          '400': { description: 'Validation error' },
        },
      },
    },
    '/channels/{id}': {
      put: {
        tags: ['Channels'],
        summary: 'Update channel configuration',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string' }, config: { type: 'object' }, enabled: { type: 'boolean' } },
              },
            },
          },
        },
        responses: { '200': { description: 'Channel updated' } },
      },
      delete: {
        tags: ['Channels'],
        summary: 'Delete a channel',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Channel deleted' } },
      },
    },

    // --- Health ---
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Global health check with channel summary',
        security: [],
        responses: {
          '200': {
            description: 'System health status',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } },
          },
        },
      },
    },
    '/health/channels': {
      get: {
        tags: ['Health'],
        summary: 'Health status for all channels',
        description: 'Returns per-channel health details including Telegram connection, WhatsApp QR code status, IMAP alive status, etc.',
        responses: {
          '200': {
            description: 'Per-channel health info',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ChannelHealth' } } } },
          },
        },
      },
    },
    '/health/channels/{id}': {
      get: {
        tags: ['Health'],
        summary: 'Health status for a specific channel',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Channel health info',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ChannelHealth' } } },
          },
          '404': { description: 'Channel not found' },
        },
      },
    },

    // --- Agent Runs ---
    '/runs': {
      get: {
        tags: ['Agent Runs'],
        summary: 'Recent agent runs',
        responses: { '200': { description: 'List of recent agent runs' } },
      },
    },

    // --- Usage / Analytics ---
    '/usage': {
      get: {
        tags: ['Usage'],
        summary: 'Overall usage summary with cost estimate',
        responses: { '200': { description: 'Usage summary' } },
      },
    },
    '/usage/daily': {
      get: {
        tags: ['Usage'],
        summary: 'Daily token breakdown',
        parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 30 } }],
        responses: { '200': { description: 'Daily usage data' } },
      },
    },
    '/usage/models': {
      get: {
        tags: ['Usage'],
        summary: 'Usage grouped by model',
        responses: { '200': { description: 'Per-model usage data' } },
      },
    },
    '/usage/calls': {
      get: {
        tags: ['Usage'],
        summary: 'Recent individual API calls',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } }],
        responses: { '200': { description: 'Recent API call log' } },
      },
    },

    // --- Loop Tasks ---
    '/tasks': {
      get: {
        tags: ['Loop Tasks'],
        summary: 'List all loop tasks',
        responses: { '200': { description: 'Task list' } },
      },
      post: {
        tags: ['Loop Tasks'],
        summary: 'Create and start a loop task',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'prompt'],
                properties: {
                  name: { type: 'string' },
                  prompt: { type: 'string' },
                  maxIterations: { type: 'integer', default: 10 },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Task created and started' } },
      },
    },
    '/tasks/{id}/start': {
      post: {
        tags: ['Loop Tasks'],
        summary: 'Restart a stopped task',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'Task started' } },
      },
    },
    '/tasks/{id}/stop': {
      post: {
        tags: ['Loop Tasks'],
        summary: 'Stop a running task',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'Task stopped' } },
      },
    },
    '/tasks/{id}/prompt': {
      get: {
        tags: ['Loop Tasks'],
        summary: 'Get task prompt',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'Task prompt content' }, '404': { description: 'Not found' } },
      },
    },
    '/tasks/{id}/output': {
      get: {
        tags: ['Loop Tasks'],
        summary: 'Get task output',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'Task output' } },
      },
    },
    '/tasks/{id}': {
      delete: {
        tags: ['Loop Tasks'],
        summary: 'Delete a task',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'Task deleted' } },
      },
    },

    // --- Tools ---
    '/tools': {
      get: {
        tags: ['Tools'],
        summary: 'List all registered tools',
        responses: { '200': { description: 'Tool list with name and description' } },
      },
    },

    // --- Skills ---
    '/skills': {
      get: {
        tags: ['Skills'],
        summary: 'List all skills (built-in + custom)',
        responses: {
          '200': {
            description: 'Skill list',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Skill' } } } },
          },
        },
      },
      post: {
        tags: ['Skills'],
        summary: 'Install a custom skill',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['manifest', 'handler'],
                properties: {
                  manifest: {
                    type: 'object',
                    required: ['name', 'description', 'inputSchema'],
                    properties: {
                      name: { type: 'string' },
                      description: { type: 'string' },
                      version: { type: 'string' },
                      inputSchema: { type: 'object' },
                    },
                  },
                  handler: { type: 'string', description: 'JavaScript handler code' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Skill installed' }, '400': { description: 'Validation error' } },
      },
    },
    '/skills/{name}': {
      put: {
        tags: ['Skills'],
        summary: 'Update a skill',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Skill updated' } },
      },
      delete: {
        tags: ['Skills'],
        summary: 'Delete a custom skill',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Skill deleted' }, '404': { description: 'Not found' } },
      },
    },
    '/skills/{name}/toggle': {
      post: {
        tags: ['Skills'],
        summary: 'Enable or disable a skill',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } } } },
        },
        responses: { '200': { description: 'Skill toggled' } },
      },
    },

    // --- Agent Groups ---
    '/agent-groups': {
      get: {
        tags: ['Agent Groups'],
        summary: 'List all agent groups',
        responses: {
          '200': {
            description: 'Agent group list',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/AgentGroup' } } } },
          },
        },
      },
      post: {
        tags: ['Agent Groups'],
        summary: 'Create an agent group',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'systemPrompt'],
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  systemPrompt: { type: 'string' },
                  apiKey: { type: 'string' },
                  model: { type: 'string' },
                  maxTokens: { type: 'integer' },
                  budgetMaxTokensDay: { type: 'integer' },
                  budgetMaxTokensMonth: { type: 'integer' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Agent group created' } },
      },
    },
    '/agent-groups/{id}': {
      get: {
        tags: ['Agent Groups'],
        summary: 'Get agent group details',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Agent group details' }, '404': { description: 'Not found' } },
      },
      put: {
        tags: ['Agent Groups'],
        summary: 'Update an agent group',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Agent group updated' } },
      },
      delete: {
        tags: ['Agent Groups'],
        summary: 'Delete an agent group',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Agent group deleted' } },
      },
    },
    '/agent-groups/{id}/assign/{channelId}': {
      post: {
        tags: ['Agent Groups'],
        summary: 'Bind a channel to a group',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'channelId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Channel assigned to group' } },
      },
    },
    '/agent-groups/{id}/unassign/{channelId}': {
      post: {
        tags: ['Agent Groups'],
        summary: 'Unbind a channel from a group',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'channelId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Channel unassigned from group' } },
      },
    },
    '/agent-groups/{id}/stats': {
      get: {
        tags: ['Agent Groups'],
        summary: 'Get group usage statistics',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Group usage stats' } },
      },
    },

    // --- A2A ---
    '/agents': {
      get: {
        tags: ['A2A'],
        summary: 'List active agents, stats, and predefined roles',
        responses: { '200': { description: 'Active agents with stats' } },
      },
    },
    '/a2a/messages': {
      get: {
        tags: ['A2A'],
        summary: 'Recent A2A messages',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } }],
        responses: { '200': { description: 'Recent A2A messages' } },
      },
    },
    '/a2a/conversations/{id}': {
      get: {
        tags: ['A2A'],
        summary: 'Messages for a specific A2A conversation',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Conversation messages' } },
      },
    },

    // --- Scheduler ---
    '/scheduler/jobs': {
      get: {
        tags: ['Scheduler'],
        summary: 'List all scheduled jobs',
        responses: {
          '200': {
            description: 'Job list',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/SchedulerJob' } } } },
          },
        },
      },
      post: {
        tags: ['Scheduler'],
        summary: 'Create a scheduled job',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'trigger', 'action', 'output'],
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  trigger: { type: 'object', description: 'Cron trigger config' },
                  action: { type: 'object', description: 'Agent action config' },
                  output: { type: 'object', description: 'Output routing config' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Job created and scheduled' } },
      },
    },
    '/scheduler/jobs/{id}': {
      put: {
        tags: ['Scheduler'],
        summary: 'Update a job',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Job updated' } },
      },
      delete: {
        tags: ['Scheduler'],
        summary: 'Delete a job',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Job deleted' } },
      },
    },
    '/scheduler/jobs/{id}/toggle': {
      post: {
        tags: ['Scheduler'],
        summary: 'Enable or disable a job',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } } } },
        },
        responses: { '200': { description: 'Job toggled' } },
      },
    },
    '/scheduler/jobs/{id}/run': {
      post: {
        tags: ['Scheduler'],
        summary: 'Trigger a job manually',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Job triggered' } },
      },
    },
    '/scheduler/jobs/{id}/runs': {
      get: {
        tags: ['Scheduler'],
        summary: 'Job execution history',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: { '200': { description: 'Job run history' } },
      },
    },
    '/scheduler/stats': {
      get: {
        tags: ['Scheduler'],
        summary: 'Scheduler statistics',
        responses: { '200': { description: 'Scheduler stats' } },
      },
    },
    '/scheduler/calendars': {
      get: {
        tags: ['Calendars'],
        summary: 'List calendar sources',
        responses: { '200': { description: 'Calendar source list' } },
      },
      post: {
        tags: ['Calendars'],
        summary: 'Add a calendar source',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'url'],
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string', format: 'uri' },
                  pollIntervalMinutes: { type: 'integer', default: 15 },
                  agentGroupId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Calendar source created' } },
      },
    },
    '/scheduler/calendars/{id}/sync': {
      post: {
        tags: ['Calendars'],
        summary: 'Sync a calendar now',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Calendar synced' }, '404': { description: 'Not found' } },
      },
    },
    '/scheduler/calendars/{id}/events': {
      get: {
        tags: ['Calendars'],
        summary: 'Get calendar events',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
        ],
        responses: { '200': { description: 'Calendar events' } },
      },
    },
    '/scheduler/calendars/{id}': {
      delete: {
        tags: ['Calendars'],
        summary: 'Delete a calendar source',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Calendar source deleted' } },
      },
    },

    // --- HITL Approvals ---
    '/approvals': {
      get: {
        tags: ['Approvals'],
        summary: 'List approvals (filter by ?status=pending)',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        ],
        responses: {
          '200': {
            description: 'Approval list',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ApprovalRequest' } } } },
          },
        },
      },
    },
    '/approvals/stats': {
      get: {
        tags: ['Approvals'],
        summary: 'Approval statistics',
        responses: { '200': { description: 'Approval stats' } },
      },
    },
    '/approvals/{id}': {
      get: {
        tags: ['Approvals'],
        summary: 'Get a specific approval request',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Approval request details' }, '404': { description: 'Not found' } },
      },
    },
    '/approvals/run/{runId}': {
      get: {
        tags: ['Approvals'],
        summary: 'Get approvals for an agent run',
        parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'Approvals for run' } },
      },
    },
    '/approvals/{id}/approve': {
      post: {
        tags: ['Approvals'],
        summary: 'Approve a pending request',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string' } } } } },
        },
        responses: { '200': { description: 'Approved' }, '404': { description: 'Not found or already resolved' } },
      },
    },
    '/approvals/{id}/reject': {
      post: {
        tags: ['Approvals'],
        summary: 'Reject a pending request',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string' } } } } },
        },
        responses: { '200': { description: 'Rejected' }, '404': { description: 'Not found or already resolved' } },
      },
    },
    '/approval-rules': {
      get: {
        tags: ['Approvals'],
        summary: 'List approval rules and defaults',
        responses: { '200': { description: 'Approval rules with default risk levels' } },
      },
      post: {
        tags: ['Approvals'],
        summary: 'Create or update an approval rule',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['toolName'],
                properties: {
                  toolName: { type: 'string' },
                  riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
                  autoApprove: { type: 'boolean' },
                  requireApproval: { type: 'boolean' },
                  timeoutSeconds: { type: 'integer' },
                  timeoutAction: { type: 'string', enum: ['approve', 'reject'] },
                  enabled: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Rule created/updated' } },
      },
    },
    '/approval-rules/{toolName}': {
      delete: {
        tags: ['Approvals'],
        summary: 'Delete an approval rule',
        parameters: [{ name: 'toolName', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Rule deleted' }, '404': { description: 'Not found' } },
      },
    },
  },
};

export const swaggerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Loop Gateway – API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    html { box-sizing: border-box; overflow-y: scroll; }
    *, *::before, *::after { box-sizing: inherit; }
    body { margin: 0; background: #fafafa; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/docs/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
    });
  </script>
</body>
</html>`;
