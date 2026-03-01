/**
 * CapCut API Tool - Programmatically create and edit CapCut/JianYing video drafts.
 *
 * Connects to a locally running CapCutAPI server (https://github.com/sun-guannan/CapCutAPI)
 * which exposes a REST API on a configurable port (default 9001).
 *
 * Workflow: create_draft → add media/text/effects → save_draft → open in CapCut
 */

import { AgentTool, ToolResult } from './types';

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_RESPONSE_LENGTH = 30000;

function getBaseUrl(): string {
  const host = process.env.CAPCUT_API_HOST || 'http://localhost';
  const port = process.env.CAPCUT_API_PORT || '9001';
  return `${host}:${port}`;
}

async function capcutRequest(
  endpoint: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<ToolResult> {
  const url = `${getBaseUrl()}${endpoint}`;
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const fetchOptions: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    };

    if (method === 'POST' && body) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);
    clearTimeout(timer);

    let responseBody: string;
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      try {
        const json = await response.json();
        responseBody = JSON.stringify(json, null, 2);
      } catch {
        responseBody = await response.text();
      }
    } else {
      responseBody = await response.text();
    }

    if (responseBody.length > MAX_RESPONSE_LENGTH) {
      responseBody = responseBody.slice(0, MAX_RESPONSE_LENGTH) + '\n...(truncated)';
    }

    return {
      content: responseBody,
      isError: response.status >= 400,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) {
      return { content: `CapCut API request timed out after ${timeout}ms`, isError: true };
    }
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return {
        content: `Cannot connect to CapCut API at ${getBaseUrl()}. Ensure the CapCutAPI server is running (python capcut_server.py).`,
        isError: true,
      };
    }
    return { content: `CapCut API error: ${msg}`, isError: true };
  }
}

// Map of action names to their REST endpoints and HTTP methods
const ACTION_ENDPOINTS: Record<string, { path: string; method: 'GET' | 'POST' }> = {
  // Core draft operations
  create_draft: { path: '/create_draft', method: 'POST' },
  save_draft: { path: '/save_draft', method: 'POST' },
  query_draft_status: { path: '/query_draft_status', method: 'POST' },
  query_script: { path: '/query_script', method: 'POST' },
  generate_draft_url: { path: '/generate_draft_url', method: 'POST' },

  // Media tracks
  add_video: { path: '/add_video', method: 'POST' },
  add_audio: { path: '/add_audio', method: 'POST' },
  add_image: { path: '/add_image', method: 'POST' },

  // Text & subtitles
  add_text: { path: '/add_text', method: 'POST' },
  add_subtitle: { path: '/add_subtitle', method: 'POST' },

  // Effects & stickers
  add_effect: { path: '/add_effect', method: 'POST' },
  add_sticker: { path: '/add_sticker', method: 'POST' },

  // Keyframes
  add_video_keyframe: { path: '/add_video_keyframe', method: 'POST' },

  // Enumeration endpoints (GET, no params)
  get_intro_animation_types: { path: '/get_intro_animation_types', method: 'GET' },
  get_outro_animation_types: { path: '/get_outro_animation_types', method: 'GET' },
  get_combo_animation_types: { path: '/get_combo_animation_types', method: 'GET' },
  get_transition_types: { path: '/get_transition_types', method: 'GET' },
  get_mask_types: { path: '/get_mask_types', method: 'GET' },
  get_audio_effect_types: { path: '/get_audio_effect_types', method: 'GET' },
  get_font_types: { path: '/get_font_types', method: 'GET' },
  get_text_intro_types: { path: '/get_text_intro_types', method: 'GET' },
  get_text_outro_types: { path: '/get_text_outro_types', method: 'GET' },
  get_text_loop_anim_types: { path: '/get_text_loop_anim_types', method: 'GET' },
  get_video_scene_effect_types: { path: '/get_video_scene_effect_types', method: 'GET' },
  get_video_character_effect_types: { path: '/get_video_character_effect_types', method: 'GET' },
};

export const capcutApiTool: AgentTool = {
  name: 'capcut_api',
  description: `Create and edit CapCut/JianYing video drafts programmatically via a local CapCutAPI server.

Workflow: create_draft → add media/text/effects → save_draft → copy draft folder to CapCut drafts → open in CapCut.

Actions (pass as "action" parameter):
- create_draft: Start a new draft (params: width, height)
- add_video: Add video clip (params: video_url, draft_id, start, end, transform_x/y, scale_x/y, speed, track_name, transition, mask_type, background_blur, volume, ...)
- add_audio: Add audio track (params: audio_url, draft_id, start, end, volume, speed, track_name, ...)
- add_image: Add image (params: image_url, draft_id, start, end, transform_x/y, scale_x/y, track_name, intro_animation, outro_animation, transition, ...)
- add_text: Add styled text (params: text, start, end, font, font_color, font_size, shadow_enabled, background_color, intro_animation, bubble_effect_id, ...)
- add_subtitle: Import SRT subtitles (params: srt, draft_id, font, font_size, font_color, time_offset, ...)
- add_effect: Apply visual effect (params: effect_type, draft_id, start, end, effect_category, ...)
- add_sticker: Add sticker (params: sticker_id, draft_id, start, end, transform_x/y, ...)
- add_video_keyframe: Add keyframe animation (params: draft_id, track_name, property_type, time, value, or batch: property_types, times, values)
- save_draft: Save and finalize (params: draft_id)
- query_draft_status: Check task status (params: task_id)
- query_script: Get draft data (params: draft_id)
- generate_draft_url: Get shareable URL (params: draft_id)
- get_*_types: List available animations/transitions/fonts/effects (no params needed)

Requires: CapCutAPI server running locally (python capcut_server.py), CapCut installed, FFmpeg for media analysis.`,

  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: Object.keys(ACTION_ENDPOINTS),
        description: 'The CapCut API action to perform',
      },
      params: {
        type: 'object',
        description:
          'Parameters for the action. Varies by action - see tool description for details. For GET actions (get_*_types), no params needed.',
      },
    },
    required: ['action'],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const action = input.action as string;
    const params = (input.params as Record<string, unknown>) || {};

    const endpoint = ACTION_ENDPOINTS[action];
    if (!endpoint) {
      return {
        content: `Unknown action: ${action}. Valid actions: ${Object.keys(ACTION_ENDPOINTS).join(', ')}`,
        isError: true,
      };
    }

    if (endpoint.method === 'GET') {
      return capcutRequest(endpoint.path, 'GET');
    }

    return capcutRequest(endpoint.path, 'POST', params);
  },
};
