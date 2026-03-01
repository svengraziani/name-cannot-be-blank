/**
 * Persona Module - Language detection, persona prompt builder, and TTS service.
 *
 * Provides:
 * - detectLanguage(): auto-detect whether input is German or English
 * - buildPersonaPrompt(): generate system prompt additions from a PersonaConfig
 * - synthesizeSpeech(): convert text to audio buffer via configurable TTS
 */

import type { PersonaConfig } from './types';

// ─── Language Detection ─────────────────────────────────────────────

// Common German words and patterns for lightweight detection.
// Not exhaustive, but sufficient for conversational messages.
const GERMAN_MARKERS = [
  // articles & pronouns
  /\b(der|die|das|ein|eine|einer|einem|einen|ich|du|er|sie|wir|ihr)\b/i,
  // verbs
  /\b(ist|sind|bin|habe|hat|haben|wird|werden|kann|können|möchte|möchten|bitte|danke|machen|gehen)\b/i,
  // conjunctions / prepositions
  /\b(und|oder|aber|nicht|mit|für|auf|von|nach|über|unter|zwischen|weil|wenn|dass|auch|noch|schon|sehr)\b/i,
  // question words
  /\b(was|wer|wie|wo|warum|wann|welche|welcher|welches)\b/i,
  // common words
  /\b(ja|nein|gut|schlecht|bitte|danke|hallo|grüße|morgen|heute|gestern)\b/i,
  // umlauts are a strong signal
  /[äöüÄÖÜß]/,
];

/**
 * Detect the language of a text string.
 * Returns 'de' for German, 'en' for English (default).
 * Only supports DE/EN for now – extendable later.
 */
export function detectLanguage(text: string): 'de' | 'en' {
  let germanScore = 0;
  for (const pattern of GERMAN_MARKERS) {
    const matches = text.match(new RegExp(pattern, 'gi'));
    if (matches) {
      germanScore += matches.length;
    }
  }
  // If ≥3 German signals found in the text, classify as German
  return germanScore >= 3 ? 'de' : 'en';
}

/**
 * Resolve the effective language for a response.
 * If persona language is "auto", detect from the user message.
 * Otherwise use the fixed language setting.
 */
export function resolveLanguage(persona: PersonaConfig, userMessage: string): string {
  if (persona.language === 'auto') {
    return detectLanguage(userMessage);
  }
  return persona.language;
}

// ─── Persona Prompt Builder ─────────────────────────────────────────

const EMOJI_INSTRUCTIONS: Record<string, string> = {
  none: 'Do NOT use any emojis in your responses.',
  minimal: 'Use emojis very sparingly – at most one per message, only where it really adds warmth.',
  moderate: "Feel free to use emojis to make your responses friendly and engaging, but don't overdo it.",
  heavy: 'Use plenty of emojis throughout your responses to be expressive and fun! 🎉🔥✨',
};

const LANGUAGE_NAMES: Record<string, string> = {
  de: 'German',
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
};

/**
 * Build additional system prompt instructions from a PersonaConfig.
 * Returns an empty string if the persona is all defaults (no-op).
 */
export function buildPersonaPrompt(persona: PersonaConfig, detectedLanguage?: string): string {
  const parts: string[] = [];

  if (persona.personality) {
    parts.push(`## Personality\n${persona.personality}`);
  }

  if (persona.responseStyle) {
    parts.push(`## Response Style\nAdopt a "${persona.responseStyle}" tone and style in all your responses.`);
  }

  const emojiInstruction = EMOJI_INSTRUCTIONS[persona.emojiUsage];
  if (emojiInstruction && persona.emojiUsage !== 'none') {
    parts.push(`## Emoji Usage\n${emojiInstruction}`);
  } else if (persona.emojiUsage === 'none') {
    parts.push(`## Emoji Usage\n${EMOJI_INSTRUCTIONS.none}`);
  }

  // Language instruction
  const lang = detectedLanguage || (persona.language !== 'auto' ? persona.language : undefined);
  if (lang && lang !== 'en') {
    const langName = LANGUAGE_NAMES[lang] || lang;
    parts.push(
      `## Language\nAlways respond in ${langName}. The user communicates in ${langName}, so match their language.`,
    );
  } else if (persona.language === 'auto') {
    parts.push(
      `## Language\nDetect the user's language and always reply in the same language. If the user writes in German, reply in German. If they write in English, reply in English.`,
    );
  }

  if (parts.length === 0) return '';
  return '\n\n# Agent Persona\n' + parts.join('\n\n');
}

// ─── TTS Service ────────────────────────────────────────────────────

const TTS_API_URL = process.env.TTS_API_URL || '';
const TTS_API_KEY = process.env.TTS_API_KEY || '';

/**
 * Synthesize speech from text using a configurable TTS provider.
 *
 * Supported providers (via TTS_API_URL env var):
 * - Empty / not set: uses Google Translate TTS (free, limited to ~200 chars per chunk)
 * - Custom URL: POST { text, language, speed } → audio/mpeg buffer
 *
 * Returns an OGG/MP3 audio Buffer, or null if TTS is unavailable.
 */
export async function synthesizeSpeech(text: string, language: string, speed: number = 1.0): Promise<Buffer | null> {
  try {
    if (TTS_API_URL) {
      return await synthesizeCustom(text, language, speed);
    }
    return await synthesizeGoogleTTS(text, language);
  } catch (err) {
    console.error('[persona:tts] Synthesis failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Google Translate TTS – free, no API key required.
 * Limited to ~200 chars per request, so we chunk long texts.
 */
async function synthesizeGoogleTTS(text: string, language: string): Promise<Buffer> {
  const langCode = language === 'de' ? 'de' : language === 'en' ? 'en' : language;
  const chunks = chunkText(text, 200);
  const audioChunks: Buffer[] = [];

  for (const chunk of chunks) {
    const url =
      `https://translate.google.com/translate_tts?ie=UTF-8&tl=${langCode}` +
      `&client=tw-ob&q=${encodeURIComponent(chunk)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!resp.ok) {
      throw new Error(`Google TTS HTTP ${resp.status}`);
    }
    const ab = await resp.arrayBuffer();
    audioChunks.push(Buffer.from(ab));
  }

  return Buffer.concat(audioChunks);
}

/**
 * Custom TTS provider – POST JSON, receive audio buffer.
 */
async function synthesizeCustom(text: string, language: string, speed: number): Promise<Buffer> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (TTS_API_KEY) headers['Authorization'] = `Bearer ${TTS_API_KEY}`;

  const resp = await fetch(TTS_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text, language, speed }),
  });

  if (!resp.ok) {
    throw new Error(`Custom TTS HTTP ${resp.status}: ${await resp.text()}`);
  }

  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Split text into chunks at sentence boundaries, respecting maxLen.
 */
function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  // Split on sentence boundaries
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  let current = '';

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length + 1 > maxLen) {
      if (current) chunks.push(current.trim());
      // If a single sentence is too long, force-split it
      if (trimmed.length > maxLen) {
        for (let i = 0; i < trimmed.length; i += maxLen) {
          chunks.push(trimmed.slice(i, i + maxLen));
        }
        current = '';
      } else {
        current = trimmed;
      }
    } else {
      current = current ? current + ' ' + trimmed : trimmed;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
