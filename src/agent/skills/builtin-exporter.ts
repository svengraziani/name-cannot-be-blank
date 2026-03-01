/**
 * Built-in Skill Exporter - Exports existing built-in tools as skill.json manifests.
 *
 * This writes skill.json files for web_browse, run_script, http_request into
 * /data/skills/ so they show up in the skill listing and can be toggled.
 * The actual execution still uses the native TypeScript tools (handler.js is a stub).
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../config';
import { SkillManifest } from './schema';

const SKILLS_DIR = path.join(config.dataDir, 'skills');

const BUILTIN_SKILLS: SkillManifest[] = [
  {
    name: 'web_browse',
    description:
      'Browse web pages using a stealth browser (Scrapling/Camoufox) that avoids bot detection. Supports navigating to URLs, extracting page content, clicking elements, filling forms, and executing JavaScript.',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to navigate to' },
        action: {
          type: 'string',
          enum: ['get_content', 'click', 'fill', 'evaluate'],
          description: 'Action to perform after navigation. Default: get_content',
        },
        selector: { type: 'string', description: 'CSS selector for click/fill actions' },
        value: { type: 'string', description: 'Value for fill action' },
        javascript: { type: 'string', description: 'JavaScript code to evaluate on the page (for evaluate action)' },
        wait_for: { type: 'string', description: 'CSS selector to wait for before performing action' },
      },
      required: ['url'],
    },
    handler: './handler.js',
    containerCompatible: false,
  },
  {
    name: 'run_script',
    description:
      'Execute a shell command or script and return its stdout/stderr output. Runs in the server environment with a configurable timeout.',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute (passed to /bin/sh -c)' },
        timeout_ms: { type: 'number', description: 'Maximum execution time in milliseconds (default: 30000)' },
        working_dir: { type: 'string', description: 'Working directory for the command (default: /tmp)' },
      },
      required: ['command'],
    },
    handler: './handler.js',
    containerCompatible: false,
  },
  {
    name: 'http_request',
    description:
      'Make HTTP requests to APIs and web services. Supports GET, POST, PUT, PATCH, DELETE methods with custom headers and JSON/text bodies.',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to send the request to' },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
          description: 'HTTP method (default: GET)',
        },
        headers: { type: 'object', description: 'Request headers as key-value pairs' },
        body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
        timeout_ms: { type: 'number', description: 'Request timeout in milliseconds (default: 30000)' },
      },
      required: ['url'],
    },
    handler: './handler.js',
    containerCompatible: true,
  },
  {
    name: 'git_clone',
    description:
      'Clone a GitHub repository and create a working branch. Returns a workspace_id used by the other git tools.',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: { type: 'string', description: 'GitHub repo URL, e.g. https://github.com/owner/repo' },
        branch: { type: 'string', description: 'Branch name to create and check out' },
        github_token: {
          type: 'string',
          description: 'GitHub personal access token (falls back to GITHUB_TOKEN env var)',
        },
        git_user_name: { type: 'string', description: 'Git author name (default: "Loop Agent")' },
        git_user_email: { type: 'string', description: 'Git author email (default: "agent@loop-gateway.local")' },
      },
      required: ['repo_url', 'branch'],
    },
    handler: './handler.js',
    containerCompatible: false,
  },
  {
    name: 'git_read_file',
    description: 'Read a file or list a directory in a cloned git workspace.',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace ID returned by git_clone' },
        path: { type: 'string', description: 'Relative path within the repo' },
      },
      required: ['workspace_id', 'path'],
    },
    handler: './handler.js',
    containerCompatible: false,
  },
  {
    name: 'git_write_file',
    description: 'Write or create a file in a cloned git workspace and auto-stage it (git add).',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace ID returned by git_clone' },
        path: { type: 'string', description: 'Relative file path within the repo' },
        content: { type: 'string', description: 'The file content to write' },
      },
      required: ['workspace_id', 'path', 'content'],
    },
    handler: './handler.js',
    containerCompatible: false,
  },
  {
    name: 'git_commit_push',
    description: 'Commit all staged changes, push to remote, and optionally create a GitHub Pull Request.',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Workspace ID returned by git_clone' },
        message: { type: 'string', description: 'Commit message' },
        create_pr: { type: 'boolean', description: 'If true, create a Pull Request after pushing' },
        pr_title: { type: 'string', description: 'PR title (defaults to commit message)' },
        pr_body: { type: 'string', description: 'PR body/description' },
        pr_base: { type: 'string', description: 'Base branch for the PR (default: "main")' },
      },
      required: ['workspace_id', 'message'],
    },
    handler: './handler.js',
    containerCompatible: false,
  },
  {
    name: 'capcut_api',
    description:
      'Create and edit CapCut/JianYing video drafts programmatically via a local CapCutAPI server. Supports creating drafts, adding video/audio/image tracks, styled text, SRT subtitles, effects, stickers, and keyframe animations. Workflow: create_draft → add media → save_draft → open in CapCut.',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'create_draft', 'add_video', 'add_audio', 'add_image', 'add_text', 'add_subtitle',
            'add_effect', 'add_sticker', 'add_video_keyframe', 'save_draft', 'query_draft_status',
            'query_script', 'generate_draft_url', 'get_intro_animation_types', 'get_outro_animation_types',
            'get_combo_animation_types', 'get_transition_types', 'get_mask_types', 'get_audio_effect_types',
            'get_font_types', 'get_text_intro_types', 'get_text_outro_types', 'get_text_loop_anim_types',
            'get_video_scene_effect_types', 'get_video_character_effect_types',
          ],
          description: 'The CapCut API action to perform',
        },
        params: {
          type: 'object',
          description: 'Parameters for the action (varies by action type)',
        },
      },
      required: ['action'],
    },
    handler: './handler.js',
    containerCompatible: false,
  },
];

const BUILTIN_HANDLER_STUB = `// Built-in skill - execution is handled natively by the gateway.
// This file exists only so the skill directory is complete.
// The actual tool implementation is in src/agent/tools/.
module.exports = {
  execute: async () => ({ content: 'Built-in skill: use native tool instead', isError: true })
};
`;

/**
 * Export built-in tools as skill manifests to /data/skills/.
 * Idempotent - only writes if the skill directory doesn't exist yet.
 */
export function exportBuiltinSkills(): void {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }

  for (const skill of BUILTIN_SKILLS) {
    const skillDir = path.join(SKILLS_DIR, skill.name);

    // Only create if not exists (don't overwrite user modifications)
    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(skill, null, 2));
      fs.writeFileSync(path.join(skillDir, 'handler.js'), BUILTIN_HANDLER_STUB);
      console.log(`[skills] Exported built-in skill: ${skill.name}`);
    }
  }
}
