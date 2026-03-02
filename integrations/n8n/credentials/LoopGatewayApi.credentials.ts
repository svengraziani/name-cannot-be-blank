import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class LoopGatewayApi implements ICredentialType {
  name = 'loopGatewayApi';
  displayName = 'Loop Gateway API';
  documentationUrl = 'https://github.com/svengraziani/loop-gateway';
  properties: INodeProperties[] = [
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'http://localhost:3000',
      placeholder: 'https://your-loop-gateway.example.com',
      description: 'The base URL of your Loop Gateway instance',
      required: true,
    },
    {
      displayName: 'Session Token',
      name: 'sessionToken',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description: 'Session token from Loop Gateway (POST /api/auth/login)',
      required: true,
    },
    {
      displayName: 'Webhook Token',
      name: 'webhookToken',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description: 'Webhook token for inbound triggers (from POST /api/webhooks)',
    },
  ];
}
