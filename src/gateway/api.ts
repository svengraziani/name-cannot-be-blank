import { Router, Request, Response } from 'express';
import { createChannel, updateChannel, removeChannel, getChannelStatuses } from '../channels/manager';
import { getRecentRuns, getUsageSummary, getUsageDaily, getUsageByModel, getRecentApiCalls } from '../db/sqlite';
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
import { getDefaultCircuitBreaker } from '../agent/resilience';
import { toolRegistry } from '../agent/tools';
import { login, logout, setupAdmin, isSetupRequired } from '../auth/middleware';
import { getAllSkills, toggleSkill, deleteSkill, installSkill, updateSkill } from '../agent/skills';
import {
  createAgentGroup,
  getAllAgentGroups,
  getAgentGroup,
  updateAgentGroup,
  deleteAgentGroup,
  assignChannelToGroup,
  unassignChannelFromGroup,
  getAgentGroupStats,
} from '../agent/groups';
import {
  getActiveAgents,
  getRecentA2AMessages,
  getA2AConversationMessages,
  getSubAgentStats,
  PREDEFINED_ROLES,
} from '../agent/a2a';
import {
  getPendingApprovals,
  getRecentApprovals,
  getApprovalRequest,
  getApprovalStats,
  getApprovalsByRun,
  respondToApproval,
  getAllApprovalRules,
  upsertApprovalRule,
  deleteApprovalRule,
  getPendingCount,
  DEFAULT_TOOL_RISK,
} from '../agent/hitl';
import {
  createJob,
  getAllJobs,
  getJob,
  updateJob,
  deleteJob,
  getJobRuns,
  scheduleJob,
  unscheduleJob,
  executeJob,
  getSchedulerStats,
  createCalendarSource,
  getAllCalendarSources,
  deleteCalendarSource,
  getCalendarEvents,
  syncCalendar,
  scheduleCalendarPoll,
  stopCalendarPoll,
  formatTriggerDescription,
} from '../scheduler';

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
    const tools = toolRegistry.getAll().map((t) => ({
      name: t.name,
      description: t.description,
    }));
    res.json(tools);
  });

  // ==================== Skills ====================

  router.get('/skills', (_req: Request, res: Response) => {
    try {
      const skills = getAllSkills();
      res.json(skills);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/skills', (req: Request, res: Response) => {
    try {
      const { manifest, handler } = req.body;
      if (!manifest || !handler) {
        res.status(400).json({ error: 'manifest and handler are required' });
        return;
      }
      if (!manifest.name || !manifest.description || !manifest.inputSchema) {
        res.status(400).json({ error: 'manifest must include name, description, and inputSchema' });
        return;
      }
      // Set defaults
      manifest.version = manifest.version || '1.0.0';
      manifest.handler = manifest.handler || './handler.js';
      manifest.containerCompatible = manifest.containerCompatible ?? false;
      manifest.sandbox = true; // custom skills are always sandboxed

      installSkill(manifest, handler);
      res.json({ status: 'installed', name: manifest.name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.put('/skills/:name', (req: Request, res: Response) => {
    try {
      const { manifest, handler } = req.body;
      updateSkill(req.params.name as string, {
        manifest,
        handlerContent: handler,
      });
      res.json({ status: 'updated' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.delete('/skills/:name', (req: Request, res: Response) => {
    try {
      const deleted = deleteSkill(req.params.name as string);
      if (!deleted) {
        res.status(404).json({ error: 'Skill not found' });
        return;
      }
      res.json({ status: 'deleted' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.post('/skills/:name/toggle', (req: Request, res: Response) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled (boolean) is required' });
        return;
      }
      toggleSkill(req.params.name as string, enabled);
      res.json({ status: 'toggled', name: req.params.name, enabled });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ==================== Agent Groups ====================

  router.get('/agent-groups', (_req: Request, res: Response) => {
    try {
      const groups = getAllAgentGroups();
      // Strip encrypted API keys from response
      const safe = groups.map((g) => ({
        ...g,
        apiKeyEncrypted: undefined,
        hasApiKey: !!g.apiKeyEncrypted,
        githubTokenEncrypted: undefined,
        hasGithubToken: !!g.githubTokenEncrypted,
      }));
      res.json(safe);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/agent-groups', (req: Request, res: Response) => {
    try {
      const {
        name,
        description,
        systemPrompt,
        apiKey,
        model,
        maxTokens,
        githubRepo,
        githubToken,
        skills,
        roles,
        containerMode,
        maxConcurrentAgents,
        budgetMaxTokensDay,
        budgetMaxTokensMonth,
        budgetAlertThreshold,
      } = req.body;

      if (!name || !systemPrompt) {
        res.status(400).json({ error: 'name and systemPrompt are required' });
        return;
      }

      const group = createAgentGroup({
        name,
        description,
        systemPrompt,
        apiKey,
        model,
        maxTokens,
        githubRepo,
        githubToken,
        skills,
        roles,
        containerMode,
        maxConcurrentAgents,
        budgetMaxTokensDay,
        budgetMaxTokensMonth,
        budgetAlertThreshold,
      });

      res.json({
        ...group,
        apiKeyEncrypted: undefined,
        hasApiKey: !!group.apiKeyEncrypted,
        githubTokenEncrypted: undefined,
        hasGithubToken: !!group.githubTokenEncrypted,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/agent-groups/:id', (req: Request, res: Response) => {
    try {
      const group = getAgentGroup(req.params.id as string);
      if (!group) {
        res.status(404).json({ error: 'Agent group not found' });
        return;
      }
      res.json({
        ...group,
        apiKeyEncrypted: undefined,
        hasApiKey: !!group.apiKeyEncrypted,
        githubTokenEncrypted: undefined,
        hasGithubToken: !!group.githubTokenEncrypted,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.put('/agent-groups/:id', (req: Request, res: Response) => {
    try {
      const group = updateAgentGroup(req.params.id as string, req.body);
      res.json({
        ...group,
        apiKeyEncrypted: undefined,
        hasApiKey: !!group.apiKeyEncrypted,
        githubTokenEncrypted: undefined,
        hasGithubToken: !!group.githubTokenEncrypted,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.delete('/agent-groups/:id', (req: Request, res: Response) => {
    try {
      deleteAgentGroup(req.params.id as string);
      res.json({ status: 'deleted' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/agent-groups/:id/assign/:channelId', (req: Request, res: Response) => {
    try {
      assignChannelToGroup(req.params.channelId as string, req.params.id as string);
      res.json({ status: 'assigned' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.post('/agent-groups/:id/unassign/:channelId', (req: Request, res: Response) => {
    try {
      unassignChannelFromGroup(req.params.channelId as string);
      res.json({ status: 'unassigned' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/agent-groups/:id/stats', (req: Request, res: Response) => {
    try {
      const stats = getAgentGroupStats(req.params.id as string);
      res.json(stats);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ==================== A2A ====================

  router.get('/agents', (_req: Request, res: Response) => {
    try {
      const agents = getActiveAgents();
      const stats = getSubAgentStats();
      res.json({ agents, stats, roles: PREDEFINED_ROLES });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/a2a/messages', (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const messages = getRecentA2AMessages(limit);
      res.json(messages);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/a2a/conversations/:id', (req: Request, res: Response) => {
    try {
      const messages = getA2AConversationMessages(req.params.id as string);
      res.json(messages);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ==================== Scheduler ====================

  router.get('/scheduler/jobs', (_req: Request, res: Response) => {
    try {
      const jobs = getAllJobs().map((j) => ({
        ...j,
        triggerDescription: formatTriggerDescription(j.trigger),
      }));
      res.json(jobs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/scheduler/jobs', (req: Request, res: Response) => {
    try {
      const { name, description, trigger, action, output } = req.body;
      if (!name || !trigger || !action || !output) {
        res.status(400).json({ error: 'name, trigger, action, and output are required' });
        return;
      }
      if (!trigger.timezone) trigger.timezone = 'UTC';
      if (!action.maxIterations) action.maxIterations = 10;

      const job = createJob({ name, description, trigger, action, output });
      scheduleJob(job.id);
      res.json({ ...job, triggerDescription: formatTriggerDescription(job.trigger) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.put('/scheduler/jobs/:id', (req: Request, res: Response) => {
    try {
      updateJob(req.params.id as string, req.body);
      const job = getJob(req.params.id as string);
      if (job?.enabled) {
        scheduleJob(job.id);
      } else if (job) {
        unscheduleJob(job.id);
      }
      res.json({ status: 'updated' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.delete('/scheduler/jobs/:id', (req: Request, res: Response) => {
    try {
      unscheduleJob(req.params.id as string);
      deleteJob(req.params.id as string);
      res.json({ status: 'deleted' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/scheduler/jobs/:id/toggle', (req: Request, res: Response) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled (boolean) is required' });
        return;
      }
      updateJob(req.params.id as string, { enabled });
      if (enabled) {
        scheduleJob(req.params.id as string);
      } else {
        unscheduleJob(req.params.id as string);
      }
      res.json({ status: 'toggled', enabled });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/scheduler/jobs/:id/run', async (req: Request, res: Response) => {
    try {
      void executeJob(req.params.id as string);
      res.json({ status: 'triggered' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/scheduler/jobs/:id/runs', (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const runs = getJobRuns(req.params.id as string, limit);
      res.json(runs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/scheduler/stats', (_req: Request, res: Response) => {
    res.json(getSchedulerStats());
  });

  // ==================== Calendars ====================

  router.get('/scheduler/calendars', (_req: Request, res: Response) => {
    try {
      res.json(getAllCalendarSources());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/scheduler/calendars', (req: Request, res: Response) => {
    try {
      const { name, url, pollIntervalMinutes, agentGroupId } = req.body;
      if (!name || !url) {
        res.status(400).json({ error: 'name and url are required' });
        return;
      }
      const source = createCalendarSource({ name, url, pollIntervalMinutes, agentGroupId });
      scheduleCalendarPoll(source.id, source.url, source.pollIntervalMinutes || 15);
      res.json(source);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/scheduler/calendars/:id/sync', async (req: Request, res: Response) => {
    try {
      const source = getAllCalendarSources().find((s) => s.id === req.params.id);
      if (!source) {
        res.status(404).json({ error: 'Calendar source not found' });
        return;
      }
      const count = await syncCalendar(source.id, source.url);
      res.json({ status: 'synced', eventCount: count });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/scheduler/calendars/:id/events', (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const events = getCalendarEvents(req.params.id as string, limit);
      res.json(events);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.delete('/scheduler/calendars/:id', (req: Request, res: Response) => {
    try {
      stopCalendarPoll(req.params.id as string);
      deleteCalendarSource(req.params.id as string);
      res.json({ status: 'deleted' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ==================== HITL Approvals ====================

  router.get('/approvals', (req: Request, res: Response) => {
    try {
      const status = req.query.status as string;
      if (status === 'pending') {
        res.json(getPendingApprovals());
      } else {
        const limit = parseInt(req.query.limit as string) || 50;
        res.json(getRecentApprovals(limit));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/approvals/stats', (_req: Request, res: Response) => {
    try {
      const stats = getApprovalStats();
      res.json({ ...stats, pendingInMemory: getPendingCount() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/approvals/:id', (req: Request, res: Response) => {
    try {
      const approval = getApprovalRequest(req.params.id as string);
      if (!approval) {
        res.status(404).json({ error: 'Approval request not found' });
        return;
      }
      res.json(approval);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/approvals/run/:runId', (req: Request, res: Response) => {
    try {
      const runId = parseInt(req.params.runId as string);
      res.json(getApprovalsByRun(runId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/approvals/:id/approve', (req: Request, res: Response) => {
    try {
      const { reason } = req.body || {};
      const respondedBy = (req as any).sessionUser?.username || 'admin';
      const ok = respondToApproval(req.params.id as string, true, reason, respondedBy);
      if (!ok) {
        res.status(404).json({ error: 'Approval not found or already resolved' });
        return;
      }
      res.json({ status: 'approved', id: req.params.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/approvals/:id/reject', (req: Request, res: Response) => {
    try {
      const { reason } = req.body || {};
      const respondedBy = (req as any).sessionUser?.username || 'admin';
      const ok = respondToApproval(req.params.id as string, false, reason, respondedBy);
      if (!ok) {
        res.status(404).json({ error: 'Approval not found or already resolved' });
        return;
      }
      res.json({ status: 'rejected', id: req.params.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // --- Approval Rules ---

  router.get('/approval-rules', (_req: Request, res: Response) => {
    try {
      const rules = getAllApprovalRules();
      res.json({ rules, defaults: DEFAULT_TOOL_RISK });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.post('/approval-rules', (req: Request, res: Response) => {
    try {
      const { toolName, riskLevel, autoApprove, requireApproval, timeoutSeconds, timeoutAction, enabled } = req.body;
      if (!toolName) {
        res.status(400).json({ error: 'toolName is required' });
        return;
      }
      const rule = upsertApprovalRule({
        toolName,
        riskLevel,
        autoApprove,
        requireApproval,
        timeoutSeconds,
        timeoutAction,
        enabled,
      });
      res.json(rule);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  router.delete('/approval-rules/:toolName', (req: Request, res: Response) => {
    try {
      const deleted = deleteApprovalRule(req.params.toolName as string);
      if (!deleted) {
        res.status(404).json({ error: 'Rule not found' });
        return;
      }
      res.json({ status: 'deleted' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ==================== Resilience ====================

  router.get('/resilience', (_req: Request, res: Response) => {
    res.json(getDefaultCircuitBreaker().getStats());
  });

  router.post('/resilience/reset', (_req: Request, res: Response) => {
    getDefaultCircuitBreaker().reset();
    res.json({ ok: true, state: 'closed' });
  });

  // ==================== Health ====================

  router.get('/health', (_req: Request, res: Response) => {
    const cbStats = getDefaultCircuitBreaker().getStats();
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      containerMode: isContainerMode(),
      circuitBreaker: cbStats.circuitState,
    });
  });

  return router;
}
