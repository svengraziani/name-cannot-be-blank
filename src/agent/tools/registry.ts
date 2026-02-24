import Anthropic from '@anthropic-ai/sdk';
import { AgentTool, ToolResult } from './types';

class ToolRegistry {
  private tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
    console.log(`[tools] Registered tool: ${tool.name}`);
  }

  getAll(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  getAllNames(): string[] {
    return Array.from(this.tools.keys());
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get Anthropic-compatible tool definitions, optionally filtered to a set of enabled tool names.
   */
  getToolDefinitions(enabledTools?: string[]): Anthropic.Tool[] {
    const tools = enabledTools
      ? this.getAll().filter(t => enabledTools.includes(t.name))
      : this.getAll();

    return tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  async execute(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: `Unknown tool: ${name}`, isError: true };
    }
    try {
      return await tool.execute(input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[tools] Error executing ${name}:`, msg);
      return { content: `Tool error: ${msg}`, isError: true };
    }
  }
}

export const toolRegistry = new ToolRegistry();
