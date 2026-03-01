import {
  IHookFunctions,
  IWebhookFunctions,
  INodeType,
  INodeTypeDescription,
  IWebhookResponseData,
  NodeConnectionType,
} from 'n8n-workflow';

export class LoopGatewayTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Loop Gateway Trigger',
    name: 'loopGatewayTrigger',
    icon: 'file:loopgateway.svg',
    group: ['trigger'],
    version: 1,
    subtitle: '={{$parameter["event"]}}',
    description: 'Triggers when events occur in Loop Gateway (agent runs, tasks, approvals)',
    defaults: {
      name: 'Loop Gateway Trigger',
    },
    inputs: [],
    outputs: [NodeConnectionType.Main],
    credentials: [
      {
        name: 'loopGatewayApi',
        required: true,
      },
    ],
    webhooks: [
      {
        name: 'default',
        httpMethod: 'POST',
        responseMode: 'onReceived',
        path: 'webhook',
      },
    ],
    properties: [
      {
        displayName: 'Event',
        name: 'event',
        type: 'options',
        options: [
          { name: 'All Events', value: '*' },
          { name: 'Agent Run Completed', value: 'agent:run:complete' },
          { name: 'Agent Run Error', value: 'agent:run:error' },
          { name: 'Agent Run Started', value: 'agent:run:start' },
          { name: 'Approval Required', value: 'approval:required' },
          { name: 'Approval Resolved', value: 'approval:resolved' },
          { name: 'Message Incoming', value: 'message:incoming' },
          { name: 'Message Reply', value: 'message:reply' },
          { name: 'Scheduler Job Completed', value: 'scheduler:job:complete' },
          { name: 'Task Completed', value: 'task:complete' },
          { name: 'Task Error', value: 'task:error' },
          { name: 'Task Iteration', value: 'task:iteration' },
          { name: 'Task Started', value: 'task:start' },
        ],
        default: 'agent:run:complete',
        required: true,
        description: 'The Loop Gateway event that triggers this workflow',
      },
      {
        displayName: 'Agent Group ID',
        name: 'agentGroupId',
        type: 'string',
        default: '',
        description: 'Optional: only trigger for events from this agent group',
      },
    ],
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const webhookData = this.getWorkflowStaticData('node');
        return !!webhookData.webhookId;
      },
      async create(this: IHookFunctions): Promise<boolean> {
        const webhookUrl = this.getNodeWebhookUrl('default') as string;
        const event = this.getNodeParameter('event') as string;
        const agentGroupId = this.getNodeParameter('agentGroupId') as string;
        const credentials = await this.getCredentials('loopGatewayApi');
        const baseUrl = (credentials.baseUrl as string).replace(/\/$/, '');
        const sessionToken = credentials.sessionToken as string;

        const body: Record<string, unknown> = {
          name: `n8n-trigger-${this.getNode().name}`,
          events: event === '*' ? ['*'] : [event],
          targetUrl: webhookUrl,
          platform: 'n8n',
        };
        if (agentGroupId) body.agentGroupId = agentGroupId;

        const response = await fetch(`${baseUrl}/api/webhooks`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          throw new Error(`Failed to register webhook: ${response.statusText}`);
        }

        const data = (await response.json()) as Record<string, string>;
        const webhookData = this.getWorkflowStaticData('node');
        webhookData.webhookId = data.id;
        return true;
      },
      async delete(this: IHookFunctions): Promise<boolean> {
        const webhookData = this.getWorkflowStaticData('node');
        const webhookId = webhookData.webhookId as string;
        if (!webhookId) return true;

        const credentials = await this.getCredentials('loopGatewayApi');
        const baseUrl = (credentials.baseUrl as string).replace(/\/$/, '');
        const sessionToken = credentials.sessionToken as string;

        try {
          await fetch(`${baseUrl}/api/webhooks/${webhookId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${sessionToken}` },
          });
        } catch {
          // Ignore cleanup errors
        }

        delete webhookData.webhookId;
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const req = this.getRequestObject();
    const body = req.body as Record<string, unknown>;

    return {
      workflowData: [
        this.helpers.returnJsonArray({
          event: body.event,
          payload: body.payload,
          timestamp: body.timestamp,
          source: body.source,
        }),
      ],
    };
  }
}
