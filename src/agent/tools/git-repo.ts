/**
 * Git Repo Workflow Tools
 *
 * 4 atomic tools that allow agents to clone repos, read files,
 * write files, commit, push, and optionally create PRs.
 *
 * Tools: git_clone, git_read_file, git_write_file, git_commit_push
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { AgentTool, ToolResult } from './types';
import { config } from '../../config';

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/*  Git Context (set per-request by the agent loop)                    */
/* ------------------------------------------------------------------ */

interface GitContext {
  githubRepo?: string;  // e.g. "owner/repo"
  githubToken?: string; // decrypted PAT
}

let currentGitContext: GitContext = {};

/**
 * Set the git context for the current agent run.
 * Called from the agent loop before tool execution starts.
 */
export function setGitContext(ctx: GitContext): void {
  currentGitContext = ctx;
}

/* ------------------------------------------------------------------ */
/*  Workspace Manager                                                  */
/* ------------------------------------------------------------------ */

interface Workspace {
  id: string;
  repoUrl: string;
  localPath: string;
  branch: string;
  token: string;
  createdAt: number;
}

const workspaces = new Map<string, Workspace>();
const MAX_WORKSPACES = 10;
const WORKSPACE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getWorkspace(id: string): Workspace | undefined {
  const ws = workspaces.get(id);
  if (ws && Date.now() - ws.createdAt > WORKSPACE_TTL_MS) {
    removeWorkspace(id);
    return undefined;
  }
  return ws;
}

function removeWorkspace(id: string): void {
  const ws = workspaces.get(id);
  if (ws) {
    try {
      fs.rmSync(ws.localPath, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    workspaces.delete(id);
  }
}

/**
 * Clean up workspaces that have exceeded their TTL.
 * Called periodically from src/index.ts.
 */
export function cleanupStaleWorkspaces(): number {
  let cleaned = 0;
  const now = Date.now();
  for (const [id, ws] of workspaces) {
    if (now - ws.createdAt > WORKSPACE_TTL_MS) {
      removeWorkspace(id);
      cleaned++;
    }
  }
  return cleaned;
}

function resolveToken(input: Record<string, unknown>): string {
  return (input.github_token as string) || currentGitContext.githubToken || config.github.token;
}

function resolveRepoUrl(input: Record<string, unknown>): string {
  const explicit = input.repo_url as string | undefined;
  if (explicit) return explicit;
  if (currentGitContext.githubRepo) {
    return `https://github.com/${currentGitContext.githubRepo}`;
  }
  return '';
}

/**
 * Validate that a resolved path stays inside the workspace root.
 */
function safePath(workspaceRoot: string, filePath: string): string {
  const resolved = path.resolve(workspaceRoot, filePath);
  if (!resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }
  return resolved;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

/* ------------------------------------------------------------------ */
/*  git_clone                                                          */
/* ------------------------------------------------------------------ */

export const gitCloneTool: AgentTool = {
  name: 'git_clone',
  description:
    'Clone a GitHub repository and create a working branch. Returns a workspace_id used by the other git tools. The token is embedded in the clone URL for authentication. If the agent group has a GitHub repo configured, repo_url and github_token can be omitted.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      repo_url: {
        type: 'string',
        description: 'GitHub repo URL, e.g. https://github.com/owner/repo. Optional if configured on the agent group.',
      },
      branch: {
        type: 'string',
        description: 'Branch name to create and check out (e.g. "feat/ai-trends")',
      },
      github_token: {
        type: 'string',
        description: 'GitHub personal access token. Falls back to GITHUB_TOKEN env var if omitted.',
      },
      git_user_name: {
        type: 'string',
        description: 'Git author name (default: "Loop Agent")',
      },
      git_user_email: {
        type: 'string',
        description: 'Git author email (default: "agent@loop-gateway.local")',
      },
    },
    required: ['branch'],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    if (workspaces.size >= MAX_WORKSPACES) {
      cleanupStaleWorkspaces();
      if (workspaces.size >= MAX_WORKSPACES) {
        return { content: `Error: Maximum ${MAX_WORKSPACES} concurrent workspaces reached. Wait for existing workspaces to expire or use an existing workspace_id.`, isError: true };
      }
    }

    const repoUrl = resolveRepoUrl(input);
    const branch = input.branch as string;
    const token = resolveToken(input);
    const userName = (input.git_user_name as string) || 'Loop Agent';
    const userEmail = (input.git_user_email as string) || 'agent@loop-gateway.local';

    if (!repoUrl || !branch) {
      return { content: 'Error: repo_url and branch are required. Either pass repo_url or configure a GitHub repo on the agent group.', isError: true };
    }

    if (!token) {
      return { content: 'Error: No GitHub token provided. Pass github_token or set GITHUB_TOKEN env var.', isError: true };
    }

    // Build authenticated clone URL
    let cloneUrl: string;
    try {
      const url = new URL(repoUrl);
      cloneUrl = `https://${token}@${url.host}${url.pathname}`;
      if (!cloneUrl.endsWith('.git')) cloneUrl += '.git';
    } catch {
      return { content: `Error: Invalid repo URL: ${repoUrl}`, isError: true };
    }

    const id = crypto.randomUUID();
    const localPath = path.join(os.tmpdir(), `loop-git-${id}`);

    try {
      // Clone with limited depth
      await git(os.tmpdir(), ['clone', '--depth=50', '--single-branch', cloneUrl, localPath]);

      // Create and checkout branch
      await git(localPath, ['checkout', '-b', branch]);

      // Configure git user
      await git(localPath, ['config', 'user.name', userName]);
      await git(localPath, ['config', 'user.email', userEmail]);

      const ws: Workspace = { id, repoUrl, localPath, branch, token, createdAt: Date.now() };
      workspaces.set(id, ws);

      return {
        content: JSON.stringify({
          workspace_id: id,
          repo: repoUrl,
          branch,
          local_path: localPath,
          message: `Repository cloned and branch "${branch}" created.`,
        }),
      };
    } catch (err: unknown) {
      // Clean up on failure
      try { fs.rmSync(localPath, { recursive: true, force: true }); } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      // Sanitize token from error messages
      const safeMsg = msg.replace(new RegExp(token, 'g'), '***');
      return { content: `Error cloning repo: ${safeMsg}`, isError: true };
    }
  },
};

/* ------------------------------------------------------------------ */
/*  git_read_file                                                      */
/* ------------------------------------------------------------------ */

export const gitReadFileTool: AgentTool = {
  name: 'git_read_file',
  description:
    'Read a file or list a directory in a cloned git workspace. Use this to inspect the repo structure and existing files before writing.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      workspace_id: {
        type: 'string',
        description: 'Workspace ID returned by git_clone',
      },
      path: {
        type: 'string',
        description: 'Relative path within the repo. Use "." or "" for the root directory.',
      },
    },
    required: ['workspace_id', 'path'],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const wsId = input.workspace_id as string;
    const filePath = (input.path as string) || '.';

    const ws = getWorkspace(wsId);
    if (!ws) {
      return { content: `Error: Workspace "${wsId}" not found or expired.`, isError: true };
    }

    let resolved: string;
    try {
      resolved = safePath(ws.localPath, filePath);
    } catch (err: unknown) {
      return { content: (err as Error).message, isError: true };
    }

    try {
      const stat = fs.statSync(resolved);

      if (stat.isDirectory()) {
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        const listing = entries.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`);
        return {
          content: JSON.stringify({
            type: 'directory',
            path: filePath,
            entries: listing,
          }),
        };
      }

      // Read file (cap at 20k chars)
      const content = fs.readFileSync(resolved, 'utf-8');
      const truncated = content.length > 20_000;
      return {
        content: JSON.stringify({
          type: 'file',
          path: filePath,
          size: content.length,
          truncated,
          content: truncated ? content.slice(0, 20_000) + '\n... (truncated)' : content,
        }),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT')) {
        return { content: `Error: Path not found: ${filePath}`, isError: true };
      }
      return { content: `Error reading path: ${msg}`, isError: true };
    }
  },
};

/* ------------------------------------------------------------------ */
/*  git_write_file                                                     */
/* ------------------------------------------------------------------ */

export const gitWriteFileTool: AgentTool = {
  name: 'git_write_file',
  description:
    'Write or create a file in a cloned git workspace and auto-stage it (git add). Creates parent directories as needed.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      workspace_id: {
        type: 'string',
        description: 'Workspace ID returned by git_clone',
      },
      path: {
        type: 'string',
        description: 'Relative file path within the repo (e.g. "_posts/2026-02-27-ai-trends.md")',
      },
      content: {
        type: 'string',
        description: 'The file content to write',
      },
    },
    required: ['workspace_id', 'path', 'content'],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const wsId = input.workspace_id as string;
    const filePath = input.path as string;
    const content = input.content as string;

    const ws = getWorkspace(wsId);
    if (!ws) {
      return { content: `Error: Workspace "${wsId}" not found or expired.`, isError: true };
    }

    if (!filePath) {
      return { content: 'Error: path is required', isError: true };
    }

    let resolved: string;
    try {
      resolved = safePath(ws.localPath, filePath);
    } catch (err: unknown) {
      return { content: (err as Error).message, isError: true };
    }

    try {
      // Create parent directories if needed
      fs.mkdirSync(path.dirname(resolved), { recursive: true });

      // Write file
      fs.writeFileSync(resolved, content, 'utf-8');

      // Auto-stage
      await git(ws.localPath, ['add', filePath]);

      return {
        content: JSON.stringify({
          path: filePath,
          size: content.length,
          staged: true,
          message: `File written and staged: ${filePath}`,
        }),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error writing file: ${msg}`, isError: true };
    }
  },
};

/* ------------------------------------------------------------------ */
/*  git_commit_push                                                    */
/* ------------------------------------------------------------------ */

export const gitCommitPushTool: AgentTool = {
  name: 'git_commit_push',
  description:
    'Commit all staged changes, push to remote, and optionally create a GitHub Pull Request. Returns the PR URL if created.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      workspace_id: {
        type: 'string',
        description: 'Workspace ID returned by git_clone',
      },
      message: {
        type: 'string',
        description: 'Commit message',
      },
      create_pr: {
        type: 'boolean',
        description: 'If true, create a Pull Request after pushing (default: false)',
      },
      pr_title: {
        type: 'string',
        description: 'PR title (defaults to commit message if omitted)',
      },
      pr_body: {
        type: 'string',
        description: 'PR body/description (optional)',
      },
      pr_base: {
        type: 'string',
        description: 'Base branch for the PR (default: "main")',
      },
    },
    required: ['workspace_id', 'message'],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const wsId = input.workspace_id as string;
    const message = input.message as string;
    const createPr = input.create_pr as boolean || false;
    const prTitle = (input.pr_title as string) || message;
    const prBody = (input.pr_body as string) || '';
    const prBase = (input.pr_base as string) || 'main';

    const ws = getWorkspace(wsId);
    if (!ws) {
      return { content: `Error: Workspace "${wsId}" not found or expired.`, isError: true };
    }

    if (!message) {
      return { content: 'Error: commit message is required', isError: true };
    }

    try {
      // Check if there are staged changes
      const status = await git(ws.localPath, ['status', '--porcelain']);
      if (!status) {
        return { content: 'Error: No changes to commit. Use git_write_file to make changes first.', isError: true };
      }

      // Commit
      await git(ws.localPath, ['commit', '-m', message]);

      // Push
      await git(ws.localPath, ['push', '-u', 'origin', ws.branch]);

      const result: Record<string, unknown> = {
        committed: true,
        pushed: true,
        branch: ws.branch,
        message,
      };

      // Create PR if requested
      if (createPr) {
        try {
          const prUrl = await createPullRequest(ws, prTitle, prBody, prBase);
          result.pr_created = true;
          result.pr_url = prUrl;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result.pr_created = false;
          result.pr_error = msg;
        }
      }

      return { content: JSON.stringify(result) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Sanitize token from error messages
      const safeMsg = msg.replace(new RegExp(ws.token, 'g'), '***');
      return { content: `Error in commit/push: ${safeMsg}`, isError: true };
    }
  },
};

/**
 * Create a Pull Request via the GitHub REST API.
 */
async function createPullRequest(
  ws: Workspace,
  title: string,
  body: string,
  base: string,
): Promise<string> {
  // Parse owner/repo from the repo URL
  const url = new URL(ws.repoUrl);
  const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Cannot parse owner/repo from URL: ${ws.repoUrl}`);
  }
  const owner = parts[0];
  const repo = parts[1];

  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls`;

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ws.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      title,
      body: body || `Created by Loop Gateway agent.\n\nBranch: ${ws.branch}`,
      head: ws.branch,
      base,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${errorBody}`);
  }

  const data = (await response.json()) as { html_url: string };
  return data.html_url;
}
