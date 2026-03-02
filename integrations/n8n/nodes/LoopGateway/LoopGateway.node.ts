import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeConnectionType,
} from 'n8n-workflow';

export class LoopGateway implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Loop Gateway',
    name: 'loopGateway',
    icon: 'file:loopgateway.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: 'Interact with Loop Gateway AI agents – run agents, manage tasks, and more',
    defaults: {
      name: 'Loop Gateway',
    },
    inputs: [NodeConnectionType.Main],
    outputs: [NodeConnectionType.Main],
    credentials: [
      {
        name: 'loopGatewayApi',
        required: true,
      },
    ],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        options: [
          {
            name: 'Run Agent',
            value: 'runAgent',
            description: 'Send a message to an AI agent and get a response',
            action: 'Run an AI agent',
          },
          {
            name: 'Create Task',
            value: 'createTask',
            description: 'Create and start an autonomous loop task',
            action: 'Create a loop task',
          },
          {
            name: 'Get Task Status',
            value: 'getTaskStatus',
            description: 'Get the current status and output of a loop task',
            action: 'Get task status',
          },
          {
            name: 'List Agent Groups',
            value: 'listGroups',
            description: 'List all configured agent groups',
            action: 'List agent groups',
          },
          {
            name: 'Get Usage Stats',
            value: 'getUsage',
            description: 'Get token usage and cost analytics',
            action: 'Get usage stats',
          },
          {
            name: 'Run Agent (Webhook)',
            value: 'runAgentWebhook',
            description: 'Trigger an agent run via webhook token (no session auth needed)',
            action: 'Run agent via webhook',
          },
        ],
        default: 'runAgent',
      },
      // --- Run Agent fields ---
      {
        displayName: 'Message',
        name: 'message',
        type: 'string',
        typeOptions: { rows: 4 },
        default: '',
        required: true,
        displayOptions: { show: { operation: ['runAgent', 'runAgentWebhook'] } },
        description: 'The message to send to the AI agent',
      },
      {
        displayName: 'Agent Group ID',
        name: 'agentGroupId',
        type: 'string',
        default: '',
        displayOptions: { show: { operation: ['runAgent', 'runAgentWebhook'] } },
        description: 'Optional agent group ID to use a specific agent configuration',
      },
      {
        displayName: 'Conversation ID',
        name: 'conversationId',
        type: 'string',
        default: '',
        displayOptions: { show: { operation: ['runAgent', 'runAgentWebhook'] } },
        description: 'Optional conversation ID to continue an existing conversation',
      },
      {
        displayName: 'Synchronous',
        name: 'sync',
        type: 'boolean',
        default: true,
        displayOptions: { show: { operation: ['runAgentWebhook'] } },
        description: 'Whether to wait for the agent response (sync) or return immediately (async)',
      },
      // --- Create Task fields ---
      {
        displayName: 'Task Name',
        name: 'taskName',
        type: 'string',
        default: '',
        required: true,
        displayOptions: { show: { operation: ['createTask'] } },
        description: 'Name for the loop task',
      },
      {
        displayName: 'Prompt',
        name: 'prompt',
        type: 'string',
        typeOptions: { rows: 4 },
        default: '',
        required: true,
        displayOptions: { show: { operation: ['createTask'] } },
        description: 'The prompt for the autonomous task',
      },
      {
        displayName: 'Max Iterations',
        name: 'maxIterations',
        type: 'number',
        default: 10,
        displayOptions: { show: { operation: ['createTask'] } },
        description: 'Maximum number of iterations for the task',
      },
      // --- Get Task Status fields ---
      {
        displayName: 'Task ID',
        name: 'taskId',
        type: 'number',
        default: 0,
        required: true,
        displayOptions: { show: { operation: ['getTaskStatus'] } },
        description: 'The ID of the loop task',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];
    const credentials = await this.getCredentials('loopGatewayApi');
    const baseUrl = (credentials.baseUrl as string).replace(/\/$/, '');
    const sessionToken = credentials.sessionToken as string;
    const webhookToken = credentials.webhookToken as string;
    const operation = this.getNodeParameter('operation', 0) as string;

    for (let i = 0; i < items.length; i++) {
      try {
        let responseData: Record<string, unknown>;

        if (operation === 'runAgent') {
          const message = this.getNodeParameter('message', i) as string;
          const agentGroupId = this.getNodeParameter('agentGroupId', i) as string;
          const conversationId = this.getNodeParameter('conversationId', i) as string;

          const body: Record<string, unknown> = { message };
          if (agentGroupId) body.agentGroupId = agentGroupId;
          if (conversationId) body.conversationId = conversationId;
          body.sync = true;

          // Use webhook endpoint if webhook token is available
          if (webhookToken) {
            responseData = await apiRequest.call(this, 'POST', `${baseUrl}/webhook/invoke/${webhookToken}`, body);
          } else {
            // Fallback: direct API (requires establishing a conversation)
            responseData = await apiRequest.call(this, 'POST', `${baseUrl}/webhook/invoke/direct`, body, sessionToken);
          }
        } else if (operation === 'runAgentWebhook') {
          const message = this.getNodeParameter('message', i) as string;
          const agentGroupId = this.getNodeParameter('agentGroupId', i) as string;
          const conversationId = this.getNodeParameter('conversationId', i) as string;
          const sync = this.getNodeParameter('sync', i) as boolean;

          const body: Record<string, unknown> = { message, sync };
          if (agentGroupId) body.agentGroupId = agentGroupId;
          if (conversationId) body.conversationId = conversationId;

          responseData = await apiRequest.call(this, 'POST', `${baseUrl}/webhook/invoke/${webhookToken}`, body);
        } else if (operation === 'createTask') {
          const name = this.getNodeParameter('taskName', i) as string;
          const prompt = this.getNodeParameter('prompt', i) as string;
          const maxIterations = this.getNodeParameter('maxIterations', i) as number;

          responseData = await apiRequest.call(
            this,
            'POST',
            `${baseUrl}/api/tasks`,
            { name, prompt, maxIterations },
            sessionToken,
          );
        } else if (operation === 'getTaskStatus') {
          const taskId = this.getNodeParameter('taskId', i) as number;
          const tasks = (await apiRequest.call(this, 'GET', `${baseUrl}/api/tasks`, undefined, sessionToken)) as Array<
            Record<string, unknown>
          >;
          responseData = tasks.find((t) => t.id === taskId) || { error: 'Task not found' };
        } else if (operation === 'listGroups') {
          responseData = { groups: await apiRequest.call(this, 'GET', `${baseUrl}/api/agent-groups`, undefined, sessionToken) };
        } else if (operation === 'getUsage') {
          responseData = (await apiRequest.call(this, 'GET', `${baseUrl}/api/usage`, undefined, sessionToken)) as Record<
            string,
            unknown
          >;
        } else {
          responseData = { error: 'Unknown operation' };
        }

        returnData.push({ json: responseData });
      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({
            json: { error: error instanceof Error ? error.message : String(error) },
          });
          continue;
        }
        throw error;
      }
    }

    return [returnData];
  }
}

async function apiRequest(
  this: IExecuteFunctions,
  method: string,
  url: string,
  body?: Record<string, unknown>,
  token?: string,
): Promise<Record<string, unknown>> {
  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  const response = await fetch(url, options);
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Loop Gateway API error (${response.status}): ${errorBody}`);
  }
  return (await response.json()) as Record<string, unknown>;
}
