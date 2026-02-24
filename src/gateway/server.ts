import express from 'express';
import expressWs from 'express-ws';
import path from 'path';
import { config } from '../config';
import { createApiRouter } from './api';
import { channelManagerEvents } from '../channels/manager';
import { agentEvents } from '../agent/loop';

export function createServer() {
  const app = express();
  const wsInstance = expressWs(app);

  app.use(express.json());

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
        if (ws.readyState === 1) { // OPEN
          ws.send(payload);
        }
      } catch {
        clients.delete(ws);
      }
    }
  }

  // Forward events to WebSocket clients
  channelManagerEvents.on('channel:status', (data) => broadcast('channel:status', data));
  channelManagerEvents.on('message:incoming', (data) => broadcast('message:incoming', data));
  channelManagerEvents.on('message:reply', (data) => broadcast('message:reply', data));
  channelManagerEvents.on('whatsapp:qr', (data) => broadcast('whatsapp:qr', data));
  agentEvents.on('run:start', (data) => broadcast('run:start', data));
  agentEvents.on('run:complete', (data) => broadcast('run:complete', data));
  agentEvents.on('run:error', (data) => broadcast('run:error', data));

  // Fallback: serve UI for any non-API route
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'ui', 'index.html'));
  });

  return app;
}
