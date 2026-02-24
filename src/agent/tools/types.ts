import Anthropic from '@anthropic-ai/sdk';

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool['input_schema'];
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}
