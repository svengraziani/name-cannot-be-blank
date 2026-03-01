import { AgentTool, ToolResult } from './types';
import {
  getFile,
  readFileBuffer,
  readFileText,
  getRecentFiles,
  extractFileContent,
  isImageMime,
  isTextExtractable,
} from '../../files';

export const processFileTool: AgentTool = {
  name: 'process_file',
  description:
    'Process uploaded files. Actions: "list" to see recent files, "read" to read text-based file contents, "extract_text" to extract text from PDFs, "info" to get file metadata. Files are uploaded by users via messaging channels (Telegram, WhatsApp, Email) or the REST API.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'read', 'extract_text', 'info'],
        description:
          'Action to perform. "list" shows recent files. "read" reads text/CSV/JSON content. "extract_text" extracts text from PDF files. "info" shows file metadata.',
      },
      file_id: {
        type: 'string',
        description: 'The file ID (UUID). Required for read, extract_text, and info actions.',
      },
      conversation_id: {
        type: 'string',
        description: 'Optional conversation ID to filter files for "list" action.',
      },
    },
    required: ['action'],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const action = input.action as string;
    const fileId = input.file_id as string | undefined;

    switch (action) {
      case 'list': {
        const files = getRecentFiles(20);
        if (files.length === 0) {
          return { content: 'No files found. Users can upload files via messaging channels or the API.' };
        }
        const list = files.map(
          (f) => `- ${f.id} | ${f.filename} | ${f.mime_type} | ${f.size} bytes | ${f.created_at}`,
        );
        return { content: `Recent files:\n${list.join('\n')}` };
      }

      case 'info': {
        if (!fileId) return { content: 'file_id is required for info action', isError: true };
        const record = getFile(fileId);
        if (!record) return { content: `File not found: ${fileId}`, isError: true };
        return {
          content: JSON.stringify(
            {
              id: record.id,
              filename: record.filename,
              mimeType: record.mime_type,
              size: record.size,
              sender: record.sender,
              channelType: record.channel_type,
              conversationId: record.conversation_id,
              createdAt: record.created_at,
              isImage: isImageMime(record.mime_type),
              isTextExtractable: isTextExtractable(record.mime_type),
            },
            null,
            2,
          ),
        };
      }

      case 'read': {
        if (!fileId) return { content: 'file_id is required for read action', isError: true };
        const content = extractFileContent(fileId);
        return { content };
      }

      case 'extract_text': {
        if (!fileId) return { content: 'file_id is required for extract_text action', isError: true };
        const result = readFileBuffer(fileId);
        if (!result) return { content: `File not found: ${fileId}`, isError: true };

        const { record } = result;

        if (isTextExtractable(record.mime_type)) {
          const textResult = readFileText(fileId);
          if (!textResult) return { content: 'Failed to read file', isError: true };
          return { content: textResult.text };
        }

        if (record.mime_type === 'application/pdf') {
          // Basic PDF text extraction: look for text streams in the raw PDF
          const pdfText = extractPdfText(result.buffer);
          if (pdfText.trim()) {
            return { content: `[Extracted from ${record.filename}]\n\n${pdfText}` };
          }
          return {
            content: `[PDF: ${record.filename}] Could not extract text - the PDF may contain scanned images. File size: ${record.size} bytes.`,
          };
        }

        return {
          content: `Cannot extract text from ${record.mime_type}. Supported: text/plain, text/csv, application/json, text/xml, application/pdf`,
          isError: true,
        };
      }

      default:
        return { content: `Unknown action: ${action}. Use: list, read, extract_text, info`, isError: true };
    }
  },
};

/**
 * Basic PDF text extraction without external dependencies.
 * Extracts text from PDF stream objects. Works well for text-based PDFs,
 * but won't work for scanned/image-only PDFs.
 */
function extractPdfText(buffer: Buffer): string {
  const content = buffer.toString('latin1');
  const textParts: string[] = [];

  // Find text between BT (Begin Text) and ET (End Text) operators
  const btEtPattern = /BT\s([\s\S]*?)ET/g;
  let match;

  while ((match = btEtPattern.exec(content)) !== null) {
    const block = match[1]!;

    // Extract text from Tj (show text) and TJ (show text with positioning) operators
    const tjPattern = /\(([^)]*)\)\s*Tj/g;
    let tjMatch;
    while ((tjMatch = tjPattern.exec(block)) !== null) {
      textParts.push(decodePdfString(tjMatch[1]!));
    }

    // TJ arrays: [(text) num (text) num ...]
    const tjArrayPattern = /\[((?:\([^)]*\)|[^[\]])*)\]\s*TJ/g;
    let tjArrMatch;
    while ((tjArrMatch = tjArrayPattern.exec(block)) !== null) {
      const arrContent = tjArrMatch[1]!;
      const strPattern = /\(([^)]*)\)/g;
      let strMatch;
      while ((strMatch = strPattern.exec(arrContent)) !== null) {
        textParts.push(decodePdfString(strMatch[1]!));
      }
    }
  }

  // Also try to find text in stream objects (for simpler PDFs)
  if (textParts.length === 0) {
    const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let streamMatch;
    while ((streamMatch = streamPattern.exec(content)) !== null) {
      const stream = streamMatch[1]!;
      // Look for readable ASCII text sequences
      const readable = stream.replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
      if (readable.length > 20) {
        textParts.push(readable);
      }
    }
  }

  return textParts.join(' ').replace(/\s+/g, ' ').trim();
}

function decodePdfString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}
