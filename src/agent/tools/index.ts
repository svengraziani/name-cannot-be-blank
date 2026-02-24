import { toolRegistry } from './registry';
import { webBrowseTool } from './web-browse';
import { runScriptTool } from './run-script';
import { httpRequestTool } from './http-request';

/**
 * Register all built-in tools.
 * Call this once at startup.
 */
export function registerBuiltinTools(): void {
  toolRegistry.register(webBrowseTool);
  toolRegistry.register(runScriptTool);
  toolRegistry.register(httpRequestTool);
  console.log(`[tools] ${toolRegistry.getAllNames().length} tools registered: ${toolRegistry.getAllNames().join(', ')}`);
}

export { toolRegistry } from './registry';
export type { AgentTool, ToolResult } from './types';
