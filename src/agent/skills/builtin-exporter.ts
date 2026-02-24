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
      'Browse web pages using a real browser (Playwright/Chromium). Supports navigating to URLs, extracting page content, clicking elements, filling forms, and executing JavaScript.',
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
