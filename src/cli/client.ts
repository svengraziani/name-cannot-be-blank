/**
 * CLI HTTP Client & Configuration
 *
 * Handles communication with the Loop Gateway API and
 * persistent config storage (~/.loop-gw.json).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';

// --- Config file management ---

interface CliConfig {
  server: string;
  token?: string;
}

const CONFIG_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.loop-gw.json');

export function loadConfig(): CliConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as CliConfig;
    }
  } catch {
    // Ignore parse errors, return defaults
  }
  return { server: 'http://localhost:3000' };
}

export function saveConfig(cfg: CliConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

// --- HTTP client ---

interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

export async function apiRequest<T = unknown>(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<ApiResponse<T>> {
  const cfg = loadConfig();
  const url = new URL(`/api${endpoint}`, cfg.server);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (cfg.token) {
    headers['Authorization'] = `Bearer ${cfg.token}`;
  }

  const payload = body ? JSON.stringify(body) : undefined;
  if (payload) {
    headers['Content-Length'] = Buffer.byteLength(payload).toString();
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: method.toUpperCase(),
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let data: T;
          try {
            data = JSON.parse(raw) as T;
          } catch {
            data = raw as unknown as T;
          }
          resolve({
            ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300,
            status: res.statusCode ?? 500,
            data,
          });
        });
      },
    );

    req.on('error', (err) => {
      reject(new Error(`Connection failed: ${err.message}\nIs the gateway running at ${cfg.server}?`));
    });

    if (payload) req.write(payload);
    req.end();
  });
}
