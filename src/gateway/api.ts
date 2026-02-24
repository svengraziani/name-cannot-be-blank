import { Router, Request, Response } from 'express';
import {
  createChannel,
  updateChannel,
  removeChannel,
  getChannelStatuses,
} from '../channels/manager';
import {
  getRecentRuns,
  getUsageSummary,
  getUsageDaily,
  getUsageByModel,
  getRecentApiCalls,
} from '../db/sqlite';
import {
  createAndStartTask,
  startTaskLoop,
  stopTask,
  getTasks,
  removeTask,
  getTaskPrompt,
  getTaskOutput,
} from '../agent/loop-mode';
import { getContainerStats } from '../agent/container-runner';
import { isContainerMode } from '../agent/loop';
import { toolRegistry } from '../agent/tools';
import {
  login,
  logout,
  setupAdmin,
  isSetupRequired,
} from '../auth/middleware';

export function createApiRouter(): Router {
  const router = Router();

  // ==================== Auth ====================

  router.get('/auth/status', (_req: Request, res: Response) => {
    res.json({ setupRequired: isSetupRequired() });
  });

  router.post('/auth/setup', (req: Request, res: Response) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        res.status(400).json({ error: 'username and password are required' });
        return;
      }
      if (password.length < 8) {
        res.status(400).json({ error: 'Password must be at least 8 characters' });
        return;
      }
      const ok = setupAdmin(username, password);
      if (!ok) {
        res.status(400).json({ error: 'Admin already exists. Use login instead.' });
        return;
      }
      const session = login(username, password);
      res.json({ status: 'created', token: session?.token });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/auth/login', (req: Request, res: Response) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        res.status(400).json({ error: 'username and password are required' });
        return;
      }
      const session = login(username, password);
      if (!session) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      res.json({ token: session.token, expiresAt: session.expiresAt });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/auth/logout', (req: Request, res: Response) => {
    const sessionId = (req as any).sessionId;
    if (sessionId) logout(sessionId);
    res.json({ status: 'ok' });
  });

  // ==================== Channels ====================

  router.get('/channels', (_req: Request, res: Response) => {
    const channels = getChannelStatuses();
    res.json(channels);
  });

  router.post('/channels', async (req: Request, res: Response) => {
    try {
      const { type, name, config } = req.body;
      if (!type || !name) {
        res.status(400).json({ error: 'type and name are required' });
        return;
      }
      const id = await createChannel(type, name, config || {});
      res.json({ id, status: 'created' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.put('/channels/:id', async (req: Request, res: Response) => {
    try {
      const { name, config, enabled } = req.body;
      await updateChannel(req.params.id as string, { name, config, enabled });
      res.json({ status: 'updated' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.delete('/channels/:id', async (req: Request, res: Response) => {
    try {
      await removeChannel(req.params.id as string);
      res.json({ status: 'deleted' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ==================== Agent Runs ====================

  router.get('/runs', (_req: Request, res: Response) => {
    const runs = getRecentRuns();
    res.json(runs);
  });

  // ==================== Usage / Analytics ====================

  router.get('/usage', (_req: Request, res: Response) => {
    const summary = getUsageSummary();
    const containerInfo = getContainerStats();
    res.json({
      ...summary,
      containerMode: isContainerMode(),
      containers: containerInfo,
    });
  });

  router.get('/usage/daily', (req: Request, res: Response) => {
    const days = parseInt(req.query.days as string) || 30;
    res.json(getUsageDaily(days));
  });

  router.get('/usage/models', (_req: Request, res: Response) => {
    res.json(getUsageByModel());
  });

  router.get('/usage/calls', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(getRecentApiCalls(limit));
  });

  // ==================== Loop Tasks ====================

  router.get('/tasks', (_req: Request, res: Response) => {
    res.json(getTasks());
  });

  router.post('/tasks', (req: Request, res: Response) => {
    try {
      const { name, prompt, maxIterations } = req.body;
      if (!name || !prompt) {
        res.status(400).json({ error: 'name and prompt are required' });
        return;
      }
      const id = createAndStartTask({
        name,
        promptContent: prompt,
        maxIterations: maxIterations || 10,
      });
      res.json({ id, status: 'started' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/tasks/:id/start', (req: Request, res: Response) => {
    try {
      startTaskLoop(parseInt(req.params.id as string));
      res.json({ status: 'started' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/tasks/:id/stop', (req: Request, res: Response) => {
    try {
      stopTask(parseInt(req.params.id as string));
      res.json({ status: 'stopped' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/tasks/:id/prompt', (req: Request, res: Response) => {
    const prompt = getTaskPrompt(parseInt(req.params.id as string));
    if (prompt === null) {
      res.status(404).json({ error: 'Task or prompt not found' });
      return;
    }
    res.json({ prompt });
  });

  router.get('/tasks/:id/output', (req: Request, res: Response) => {
    const output = getTaskOutput(parseInt(req.params.id as string));
    res.json({ output: output || '' });
  });

  router.delete('/tasks/:id', (req: Request, res: Response) => {
    try {
      removeTask(parseInt(req.params.id as string));
      res.json({ status: 'deleted' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ==================== Tools ====================

  router.get('/tools', (_req: Request, res: Response) => {
    const tools = toolRegistry.getAll().map(t => ({
      name: t.name,
      description: t.description,
    }));
    res.json(tools);
  });

  // ==================== Health ====================

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      containerMode: isContainerMode(),
    });
  });

  return router;
}
