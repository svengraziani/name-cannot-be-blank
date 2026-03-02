export {
  initFileHandling,
  storeFile,
  getFile,
  readFileBuffer,
  readFileText,
  getConversationFiles,
  getRecentFiles,
  deleteFile,
  isImageMime,
  isTextExtractable,
  extractFileContent,
  validateMimeType,
} from './storage';

export type { FileAttachment, FileRecord } from './storage';
