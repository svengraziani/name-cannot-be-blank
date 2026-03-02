/**
 * Channel Context Injection
 *
 * Defines per-channel communication style hints that are automatically
 * injected into the system prompt. The agent adapts its tone, length,
 * and formatting based on the originating channel — no separate prompt
 * per channel required.
 */

export interface ChannelStyleHint {
  /** Short label shown in logs */
  label: string;
  /** Instruction block appended to the system prompt */
  instruction: string;
}

/**
 * Built-in style hints keyed by channel type.
 * These match the `channelType` values used throughout the codebase
 * (telegram, whatsapp, email, mattermost).
 */
const defaultStyleHints: Record<string, ChannelStyleHint> = {
  telegram: {
    label: 'Telegram',
    instruction: [
      '## Channel: Telegram',
      'The user is writing from Telegram.',
      '- Keep responses short and casual.',
      '- Use concise paragraphs — mobile screens are small.',
      '- Avoid lengthy greetings or sign-offs.',
      '- Markdown formatting (bold, italic, code) is supported.',
    ].join('\n'),
  },
  whatsapp: {
    label: 'WhatsApp',
    instruction: [
      '## Channel: WhatsApp',
      'The user is writing from WhatsApp.',
      '- Keep responses short and conversational.',
      '- Emojis are welcome where they add clarity or friendliness.',
      '- Avoid large code blocks — they render poorly on mobile.',
      '- Use simple formatting (bold with *asterisks*).',
    ].join('\n'),
  },
  email: {
    label: 'Email',
    instruction: [
      '## Channel: Email',
      'The user is writing via Email.',
      '- Use a professional, structured tone.',
      '- Start with an appropriate greeting and end with a sign-off.',
      '- Organize longer answers with headings or bullet points.',
      '- Full Markdown formatting is supported.',
    ].join('\n'),
  },
  mattermost: {
    label: 'Mattermost',
    instruction: [
      '## Channel: Mattermost',
      'The user is writing from Mattermost (team chat).',
      '- Keep responses focused and team-friendly.',
      '- Use Markdown formatting — code blocks, tables, and links are well supported.',
      '- Be concise but thorough for technical topics.',
    ].join('\n'),
  },
};

/**
 * Return the style instruction for a given channel type.
 * Returns an empty string for unknown channel types so the prompt
 * stays clean when no hint is available.
 */
export function getChannelStyleHint(channelType: string): string {
  const hint = defaultStyleHints[channelType];
  return hint ? hint.instruction : '';
}

/**
 * Append channel context to an existing system prompt.
 * If the channel type is unknown the original prompt is returned unchanged.
 */
export function injectChannelContext(systemPrompt: string, channelType: string): string {
  const hint = getChannelStyleHint(channelType);
  if (!hint) return systemPrompt;
  return `${systemPrompt}\n\n${hint}`;
}
