import { toolRegistry } from './registry';
import { webBrowseTool } from './web-browse';
import { runScriptTool } from './run-script';
import { httpRequestTool } from './http-request';
import { delegateTaskTool, broadcastEventTool, queryAgentsTool } from '../a2a/tools';

/**
 * Register all built-in tools.
 * Call this once at startup.
 */
export function registerBuiltinTools(): void {
  toolRegistry.register(webBrowseTool);
  toolRegistry.register(runScriptTool);
  toolRegistry.register(httpRequestTool);

  // A2A tools
  toolRegistry.register(delegateTaskTool);
  toolRegistry.register(broadcastEventTool);
  toolRegistry.register(queryAgentsTool);

  console.log(`[tools] ${toolRegistry.getAllNames().length} tools registered: ${toolRegistry.getAllNames().join(', ')}`);
}

export { toolRegistry } from './registry';
export type { AgentTool, ToolResult } from './types';
