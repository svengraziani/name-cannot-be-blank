import { config } from './config';
import { createServer } from './gateway/server';
import { initChannels } from './channels/manager';
import { loadSystemPrompt, initAgentRuntime } from './agent/loop';

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

  // Initialize agent runtime (checks container availability)
  await initAgentRuntime();

  // Create HTTP/WS server
  const app = createServer();

  // Initialize channels from database
  await initChannels();

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
