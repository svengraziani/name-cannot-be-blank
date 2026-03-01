import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import { config } from '../config';
import { getDb } from '../db/sqlite';

export interface FileAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  storagePath: string;
}

export interface FileRecord {
  id: string;
  conversation_id: string | null;
  channel_type: string | null;
  sender: string | null;
  filename: string;
  mime_type: string;
  size: number;
  storage_path: string;
  created_at: string;
}

const ALLOWED_MIME_TYPES = new Set([
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  // Documents
  'application/pdf',
  'text/csv',
  'text/plain',
  'application/json',
  'text/xml',
  'application/xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
]);

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * Initialize file handling: DB schema + storage directory.
 */
export function initFileHandling(): void {
  const filesDir = getFilesDir();
  if (!fs.existsSync(filesDir)) {
    fs.mkdirSync(filesDir, { recursive: true });
    console.log(`[files] Created storage directory: ${filesDir}`);
  }

  getDb().exec(`
    CREATE TABLE IF NOT EXISTS file_attachments (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      channel_type TEXT,
      sender TEXT,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_files_conversation ON file_attachments(conversation_id);
  `);
  console.log('[files] File handling initialized');
}

function getFilesDir(): string {
  return path.join(config.dataDir, 'files');
}

/**
 * Validate and detect the MIME type. Returns null if not allowed.
 */
export function validateMimeType(mimeType: string): boolean {
  return ALLOWED_MIME_TYPES.has(mimeType);
}

/**
 * Store a file from a buffer. Returns the FileAttachment metadata.
 */
export function storeFile(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  conversationId?: string,
  channelType?: string,
  sender?: string,
): FileAttachment {
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`File too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_FILE_SIZE / 1024 / 1024}MB`);
  }

  if (!validateMimeType(mimeType)) {
    throw new Error(`Unsupported file type: ${mimeType}`);
  }

  const id = uuid();
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = path.join(getFilesDir(), id);
  fs.mkdirSync(dir, { recursive: true });

  const storagePath = path.join(dir, safeFilename);
  fs.writeFileSync(storagePath, buffer);

  getDb()
    .prepare(
      'INSERT INTO file_attachments (id, conversation_id, channel_type, sender, filename, mime_type, size, storage_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, conversationId || null, channelType || null, sender || null, filename, mimeType, buffer.length, storagePath);

  console.log(`[files] Stored file: ${filename} (${mimeType}, ${buffer.length} bytes) -> ${id}`);

  return { id, filename, mimeType, size: buffer.length, storagePath };
}

/**
 * Get file metadata by ID.
 */
export function getFile(id: string): FileRecord | undefined {
  return getDb().prepare('SELECT * FROM file_attachments WHERE id = ?').get(id) as FileRecord | undefined;
}

/**
 * Read file contents as a buffer.
 */
export function readFileBuffer(id: string): { buffer: Buffer; record: FileRecord } | undefined {
  const record = getFile(id);
  if (!record || !fs.existsSync(record.storage_path)) return undefined;
  return { buffer: fs.readFileSync(record.storage_path), record };
}

/**
 * Read file contents as a text string (for text-based files).
 */
export function readFileText(id: string): { text: string; record: FileRecord } | undefined {
  const result = readFileBuffer(id);
  if (!result) return undefined;
  return { text: result.buffer.toString('utf-8'), record: result.record };
}

/**
 * List files for a conversation.
 */
export function getConversationFiles(conversationId: string): FileRecord[] {
  return getDb()
    .prepare('SELECT * FROM file_attachments WHERE conversation_id = ? ORDER BY created_at DESC')
    .all(conversationId) as FileRecord[];
}

/**
 * List recent files.
 */
export function getRecentFiles(limit = 50): FileRecord[] {
  return getDb()
    .prepare('SELECT * FROM file_attachments ORDER BY created_at DESC LIMIT ?')
    .all(limit) as FileRecord[];
}

/**
 * Delete a file from storage and database.
 */
export function deleteFile(id: string): boolean {
  const record = getFile(id);
  if (!record) return false;

  // Remove file from disk
  try {
    if (fs.existsSync(record.storage_path)) {
      fs.unlinkSync(record.storage_path);
    }
    const dir = path.dirname(record.storage_path);
    if (fs.existsSync(dir)) {
      const remaining = fs.readdirSync(dir);
      if (remaining.length === 0) {
        fs.rmdirSync(dir);
      }
    }
  } catch (err) {
    console.warn(`[files] Failed to delete file from disk: ${id}`, err);
  }

  getDb().prepare('DELETE FROM file_attachments WHERE id = ?').run(id);
  return true;
}

/**
 * Check if a MIME type is an image (for Claude vision support).
 */
export function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/**
 * Check if a MIME type is a text-based format that can be extracted.
 */
export function isTextExtractable(mimeType: string): boolean {
  return (
    mimeType === 'text/plain' ||
    mimeType === 'text/csv' ||
    mimeType === 'application/json' ||
    mimeType === 'text/xml' ||
    mimeType === 'application/xml'
  );
}

/**
 * Extract text content from a file for agent processing.
 * Returns a text summary suitable for including in agent context.
 */
export function extractFileContent(id: string): string {
  const result = readFileBuffer(id);
  if (!result) return `[File ${id} not found]`;

  const { buffer, record } = result;

  if (isTextExtractable(record.mime_type)) {
    const text = buffer.toString('utf-8');
    const maxChars = 50000;
    if (text.length > maxChars) {
      return `[File: ${record.filename}]\n${text.slice(0, maxChars)}\n...(truncated, ${text.length} chars total)`;
    }
    return `[File: ${record.filename}]\n${text}`;
  }

  if (record.mime_type === 'application/pdf') {
    return `[PDF file: ${record.filename}, ${record.size} bytes. Use the process_file tool with action "extract_text" to extract content.]`;
  }

  if (isImageMime(record.mime_type)) {
    return `[Image: ${record.filename} (${record.mime_type}, ${record.size} bytes). This image has been sent to the AI for visual analysis.]`;
  }

  return `[File: ${record.filename} (${record.mime_type}, ${record.size} bytes)]`;
}
