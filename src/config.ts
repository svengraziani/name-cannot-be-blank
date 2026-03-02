export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  agentModel: process.env.AGENT_MODEL || 'claude-sonnet-4-20250514',
  agentMaxTokens: parseInt(process.env.AGENT_MAX_TOKENS || '16384', 10),
  agentSystemPromptFile: process.env.AGENT_SYSTEM_PROMPT_FILE || '/data/system-prompt.md',

  // --- Retry & Circuit Breaker ---
  retry: {
    maxRetries: parseInt(process.env.RETRY_MAX_RETRIES || '3', 10),
    baseDelayMs: parseInt(process.env.RETRY_BASE_DELAY_MS || '1000', 10),
    maxDelayMs: parseInt(process.env.RETRY_MAX_DELAY_MS || '30000', 10),
    jitterFactor: parseFloat(process.env.RETRY_JITTER_FACTOR || '0.2'),
  },
  circuitBreaker: {
    failureThreshold: parseInt(process.env.CB_FAILURE_THRESHOLD || '5', 10),
    resetTimeoutMs: parseInt(process.env.CB_RESET_TIMEOUT_MS || '60000', 10),
    halfOpenSuccessThreshold: parseInt(process.env.CB_HALF_OPEN_SUCCESS_THRESHOLD || '1', 10),
  },

  dataDir: process.env.DATA_DIR || '/data',
  dbPath: process.env.DB_PATH || '/data/gateway.db',

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    allowedUsers: (process.env.TELEGRAM_ALLOWED_USERS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  whatsapp: {
    enabled: process.env.WHATSAPP_ENABLED === 'true',
  },

  github: {
    token: process.env.GITHUB_TOKEN || '',
  },

  email: {
    imapHost: process.env.EMAIL_IMAP_HOST || '',
    imapPort: parseInt(process.env.EMAIL_IMAP_PORT || '993', 10),
    imapUser: process.env.EMAIL_IMAP_USER || '',
    imapPass: process.env.EMAIL_IMAP_PASS || '',
    smtpHost: process.env.EMAIL_SMTP_HOST || '',
    smtpPort: parseInt(process.env.EMAIL_SMTP_PORT || '587', 10),
    smtpUser: process.env.EMAIL_SMTP_USER || '',
    smtpPass: process.env.EMAIL_SMTP_PASS || '',
    pollIntervalMs: parseInt(process.env.EMAIL_POLL_INTERVAL_MS || '30000', 10),
    allowedSenders: (process.env.EMAIL_ALLOWED_SENDERS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
};
