import { Router, Request, Response } from 'express';
import {
  createChannel,
  updateChannel,
  removeChannel,
  getChannelStatuses,
} from '../channels/manager';
import { getRecentRuns } from '../db/sqlite';

export function createApiRouter(): Router {
  const router = Router();

  // --- Channels ---

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

  // --- Agent Runs ---

  router.get('/runs', (_req: Request, res: Response) => {
    const runs = getRecentRuns();
    res.json(runs);
  });

  // --- Health ---

  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  return router;
}
