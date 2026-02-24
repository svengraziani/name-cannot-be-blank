/**
 * Output Router - Routes job results to the configured destination.
 *
 * Supported destinations:
 * - Channel: Send to a messaging channel (Telegram, WhatsApp, Email)
 * - Webhook: HTTP POST to external URL
 * - File: Write to disk
 * - Email: Send via SMTP
 */

import * as fs from 'fs';
import * as path from 'path';
import { ScheduleOutput } from './types';
import { config } from '../config';

/**
 * Route a job result to its configured output destination.
 */
export async function routeOutput(output: ScheduleOutput, result: string, jobName: string): Promise<void> {
  switch (output.type) {
    case 'channel':
      await routeToChannel(output, result);
      break;
    case 'webhook':
      await routeToWebhook(output, result, jobName);
      break;
    case 'file':
      await routeToFile(output, result, jobName);
      break;
    case 'email':
      await routeToEmail(output, result, jobName);
      break;
    default:
      console.warn(`[output-router] Unknown output type: ${output.type}`);
  }
}

async function routeToChannel(output: ScheduleOutput, result: string): Promise<void> {
  if (!output.channelId) {
    console.warn('[output-router] No channelId specified for channel output');
    return;
  }

  // Import dynamically to avoid circular deps
  const { getChannelAdapter } = await import('../channels/manager');
  const adapter = getChannelAdapter(output.channelId);

  if (!adapter) {
    console.error(`[output-router] Channel ${output.channelId} not found or not active`);
    return;
  }

  const chatId = output.chatId || 'default';

  // Split long messages for channels with limits
  const MAX_MSG_LENGTH = 4000;
  if (result.length <= MAX_MSG_LENGTH) {
    await adapter.sendMessage(chatId, result);
  } else {
    const parts = splitMessage(result, MAX_MSG_LENGTH);
    for (const part of parts) {
      await adapter.sendMessage(chatId, part);
    }
  }

  console.log(`[output-router] Sent to channel ${output.channelId}`);
}

async function routeToWebhook(output: ScheduleOutput, result: string, jobName: string): Promise<void> {
  if (!output.webhookUrl) {
    console.warn('[output-router] No webhookUrl specified for webhook output');
    return;
  }

  try {
    const response = await fetch(output.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job: jobName,
        result,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      console.error(`[output-router] Webhook returned ${response.status}: ${response.statusText}`);
    } else {
      console.log(`[output-router] Webhook delivered to ${output.webhookUrl}`);
    }
  } catch (err) {
    console.error(`[output-router] Webhook failed:`, err);
  }
}

async function routeToFile(output: ScheduleOutput, result: string, jobName: string): Promise<void> {
  const filePath = output.filePath || path.join(config.dataDir, 'scheduler-output', `${jobName.replace(/[^a-zA-Z0-9-_]/g, '_')}.md`);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const header = `# ${jobName}\n\nGenerated: ${new Date().toISOString()}\n\n---\n\n`;
  fs.writeFileSync(filePath, header + result, 'utf-8');
  console.log(`[output-router] Written to file: ${filePath}`);
}

async function routeToEmail(output: ScheduleOutput, result: string, jobName: string): Promise<void> {
  if (!output.emailTo) {
    console.warn('[output-router] No emailTo specified for email output');
    return;
  }

  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport({
      host: config.email.smtpHost,
      port: config.email.smtpPort,
      secure: config.email.smtpPort === 465,
      auth: {
        user: config.email.smtpUser,
        pass: config.email.smtpPass,
      },
    });

    await transporter.sendMail({
      from: config.email.smtpUser || 'loop-gateway@localhost',
      to: output.emailTo,
      subject: `[Loop Gateway] ${jobName}`,
      text: result,
    });

    console.log(`[output-router] Email sent to ${output.emailTo}`);
  } catch (err) {
    console.error(`[output-router] Email failed:`, err);
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx < maxLength / 2) splitIdx = maxLength;
    parts.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return parts;
}
