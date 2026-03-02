import Anthropic from '@anthropic-ai/sdk';

export interface FileAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  files?: FileAttachment[];
}

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool['input_schema'];
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}
