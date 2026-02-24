export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  agentModel: process.env.AGENT_MODEL || 'claude-sonnet-4-20250514',
  agentMaxTokens: parseInt(process.env.AGENT_MAX_TOKENS || '8192', 10),
  agentSystemPromptFile: process.env.AGENT_SYSTEM_PROMPT_FILE || '/data/system-prompt.md',

  dataDir: process.env.DATA_DIR || '/data',
  dbPath: process.env.DB_PATH || '/data/gateway.db',

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    allowedUsers: (process.env.TELEGRAM_ALLOWED_USERS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  },

  whatsapp: {
    enabled: process.env.WHATSAPP_ENABLED === 'true',
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
      .map(s => s.trim())
      .filter(Boolean),
  },
};
