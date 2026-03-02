import express from 'express';
import expressWs from 'express-ws';
import path from 'path';
import { createApiRouter } from './api';
import { channelManagerEvents, getChannelAdapter } from '../channels/manager';
import { MattermostAdapter } from '../channels/mattermost';
import { WebhookAdapter } from '../channels/webhook';
import { agentEvents } from '../agent/loop';
import { containerEvents } from '../agent/container-runner';
import { loopEvents } from '../agent/loop-mode';
import { authMiddleware, rateLimitMiddleware } from '../auth/middleware';
import { a2aEvents } from '../agent/a2a';
import { schedulerEvents, calendarEvents } from '../scheduler';
import { skillWatcherEvents } from '../agent/skills';
import { approvalEvents, notifyApprovalRequired, notifyApprovalResolved } from '../agent/hitl';

export function createServer() {
  const app = express();
  const wsInstance = expressWs(app);

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Mattermost webhook (outside auth - Mattermost verifies via token)
  app.post('/webhook/mattermost/:channelId', (req, res) => {
    const adapter = getChannelAdapter(req.params.channelId);
    if (!adapter || !(adapter instanceof MattermostAdapter)) {
      res.status(404).json({ text: 'Channel not found' });
      return;
    }
    adapter.handleSlashCommand(req, res);
  });

  // Generic webhook inbound (outside auth - verified via channel secret)
  app.post('/webhook/incoming/:channelId', (req, res) => {
    const adapter = getChannelAdapter(req.params.channelId);
    if (!adapter || !(adapter instanceof WebhookAdapter)) {
      res.status(404).json({ error: 'Webhook channel not found' });
      return;
    }
    adapter.handleIncomingWebhook(req, res);
  });

  // Rate limiting on API endpoints
  app.use('/api', rateLimitMiddleware(120, 60));

  // Auth middleware for API (except health and auth endpoints)
  app.use('/api', authMiddleware);

  // Serve static UI files
  app.use(express.static(path.join(__dirname, '..', '..', 'ui')));

  // API routes
  app.use('/api', createApiRouter());

  // WebSocket for live events
  const wsApp = wsInstance.app;
  const clients = new Set<any>();

  wsApp.ws('/ws', (ws, _req) => {
    clients.add(ws);
    console.log(`[ws] Client connected (total: ${clients.size})`);

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[ws] Client disconnected (total: ${clients.size})`);
    });
  });

  function broadcast(event: string, data: unknown) {
    const payload = JSON.stringify({ event, data, ts: Date.now() });
    for (const ws of clients) {
      try {
        if (ws.readyState === 1) {
          // OPEN
          ws.send(payload);
        }
      } catch {
        clients.delete(ws);
      }
    }
  }

  // Forward channel events
  channelManagerEvents.on('channel:status', (data) => broadcast('channel:status', data));
  channelManagerEvents.on('message:incoming', (data) => broadcast('message:incoming', data));
  channelManagerEvents.on('message:reply', (data) => broadcast('message:reply', data));
  channelManagerEvents.on('whatsapp:qr', (data) => broadcast('whatsapp:qr', data));

  // Forward agent events
  agentEvents.on('run:start', (data) => broadcast('run:start', data));
  agentEvents.on('run:complete', (data) => broadcast('run:complete', data));
  agentEvents.on('run:error', (data) => broadcast('run:error', data));

  // Forward container events
  containerEvents.on('container:start', (data) => broadcast('container:start', data));
  containerEvents.on('container:end', (data) => broadcast('container:end', data));

  // Forward loop task events
  loopEvents.on('task:start', (data) => broadcast('task:start', data));
  loopEvents.on('task:iteration', (data) => broadcast('task:iteration', data));
  loopEvents.on('task:output', (data) => broadcast('task:output', data));
  loopEvents.on('task:complete', (data) => broadcast('task:complete', data));
  loopEvents.on('task:error', (data) => broadcast('task:error', data));
  loopEvents.on('task:stop', (data) => broadcast('task:stop', data));

  // Forward A2A events
  a2aEvents.on('message:sent', (data) => broadcast('a2a:message', data));
  a2aEvents.on('agent:registered', (data) => broadcast('a2a:agent:registered', data));
  a2aEvents.on('agent:unregistered', (data) => broadcast('a2a:agent:unregistered', data));
  a2aEvents.on('agent:spawned', (data) => broadcast('a2a:agent:spawned', data));
  a2aEvents.on('agent:stopped', (data) => broadcast('a2a:agent:stopped', data));

  // Forward scheduler events
  schedulerEvents.on('job:start', (data) => broadcast('scheduler:job:start', data));
  schedulerEvents.on('job:complete', (data) => broadcast('scheduler:job:complete', data));
  schedulerEvents.on('job:error', (data) => broadcast('scheduler:job:error', data));

  // Forward calendar events
  calendarEvents.on('calendar:synced', (data) => broadcast('calendar:synced', data));
  calendarEvents.on('calendar:error', (data) => broadcast('calendar:error', data));

  // Forward skills watcher events
  skillWatcherEvents.on('skills:reloaded', (data) => broadcast('skills:reloaded', data));

  // Forward HITL approval events
  approvalEvents.on('approval:required', (data) => {
    broadcast('approval:required', data);
    void notifyApprovalRequired(data);
  });
  approvalEvents.on('approval:resolved', (data) => {
    broadcast('approval:resolved', data);
    void notifyApprovalResolved(data);
  });
  approvalEvents.on('approval:timeout', (data) => broadcast('approval:timeout', data));

  // Fallback: serve UI for any non-API route
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'ui', 'index.html'));
  });

  return app;
}
