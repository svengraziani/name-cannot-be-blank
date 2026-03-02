import { toolRegistry } from './registry';
import { webBrowseTool } from './web-browse';
import { runScriptTool } from './run-script';
import { httpRequestTool } from './http-request';
import { capcutApiTool } from './capcut-api';
import { delegateTaskTool, broadcastEventTool, queryAgentsTool } from '../a2a/tools';
import { gitCloneTool, gitReadFileTool, gitWriteFileTool, gitCommitPushTool } from './git-repo';
import { processFileTool } from './file-process';

/**
 * Register all built-in tools.
 * Call this once at startup.
 */
export function registerBuiltinTools(): void {
  toolRegistry.register(webBrowseTool);
  toolRegistry.register(runScriptTool);
  toolRegistry.register(httpRequestTool);
  toolRegistry.register(capcutApiTool);

  // A2A tools
  toolRegistry.register(delegateTaskTool);
  toolRegistry.register(broadcastEventTool);
  toolRegistry.register(queryAgentsTool);

  // Git repo workflow tools
  toolRegistry.register(gitCloneTool);
  toolRegistry.register(gitReadFileTool);
  toolRegistry.register(gitWriteFileTool);
  toolRegistry.register(gitCommitPushTool);

  // File processing tool
  toolRegistry.register(processFileTool);

  console.log(
    `[tools] ${toolRegistry.getAllNames().length} tools registered: ${toolRegistry.getAllNames().join(', ')}`,
  );
}

export { toolRegistry } from './registry';
export type { AgentTool, ToolResult } from './types';
