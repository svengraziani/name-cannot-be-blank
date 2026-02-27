import { config } from './config';
import { createServer } from './gateway/server';
import { initChannels } from './channels/manager';
import { loadSystemPrompt, initAgentRuntime } from './agent/loop';
import { registerBuiltinTools } from './agent/tools';
import { exportBuiltinSkills, loadAndRegisterSkills, startSkillWatcher } from './agent/skills';
import { initAgentGroupsSchema } from './agent/groups';
import { initA2ASchema } from './agent/a2a';
import { initSchedulerSchema, startScheduler, startCalendarPolling } from './scheduler';
import { initHitlSchema, expireStaleApprovals } from './agent/hitl';
import { cleanupStaleWorkspaces } from './agent/tools/git-repo';

async function main() {
  console.log('='.repeat(50));
  console.log('  Loop Gateway - Agentic Loop Manager');
  console.log('='.repeat(50));

  // Validate required config
  if (!config.anthropicApiKey) {
    console.error('[FATAL] ANTHROPIC_API_KEY is not set. Set it in .env');
    process.exit(1);
  }

  // Load system prompt
  loadSystemPrompt();

  // Register built-in tools (web_browse, run_script, http_request + A2A tools)
  registerBuiltinTools();

  // Export built-in tools as skill manifests to /data/skills/
  exportBuiltinSkills();

  // Load custom skills from /data/skills/ and register in tool registry
  loadAndRegisterSkills();

  // Initialize agent runtime (checks container availability)
  await initAgentRuntime();

  // Initialize agent groups DB schema (migration-safe)
  initAgentGroupsSchema();

  // Initialize A2A message bus schema
  initA2ASchema();

  // Initialize scheduler DB schema
  initSchedulerSchema();

  // Initialize HITL approval schema
  initHitlSchema();

  // Create HTTP/WS server
  const app = createServer();

  // Initialize channels from database
  await initChannels();

  // Start scheduler engine (cron jobs, intervals)
  startScheduler();

  // Start calendar polling (iCal sync)
  startCalendarPolling();

  // Start skills hot-reload watcher
  startSkillWatcher();

  // Periodic cleanup of stale approval requests (every 60s)
  setInterval(() => {
    const expired = expireStaleApprovals();
    if (expired > 0) {
      console.log(`[hitl] Expired ${expired} stale approval(s)`);
    }
  }, 60_000);

  // Periodic cleanup of stale git workspaces (every 5 min)
  setInterval(() => {
    const cleaned = cleanupStaleWorkspaces();
    if (cleaned > 0) {
      console.log(`[git] Cleaned up ${cleaned} stale workspace(s)`);
    }
  }, 5 * 60_000);

  // Start listening
  app.listen(config.port, config.host, () => {
    console.log(`[server] Listening on http://${config.host}:${config.port}`);
    console.log(`[server] Open the Web UI to manage channels and monitor the agent loop`);
  });
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
