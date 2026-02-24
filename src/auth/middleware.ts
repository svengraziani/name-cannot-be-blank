/**
 * Authentication & Rate Limiting Middleware
 *
 * - Session-based auth with secure tokens
 * - Password hashing via Node.js built-in crypto (no bcrypt dependency)
 * - Rate limiting per IP via SQLite
 * - Setup flow: first user becomes admin
 */

import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import {
  getUserByUsername,
  createUser,
  getUserCount,
  createSession,
  getSession,
  deleteSession,
  cleanExpiredSessions,
  checkRateLimit,
} from '../db/sqlite';

// --- Password hashing (scrypt, no external deps) ---

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const hashToVerify = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashToVerify, 'hex'));
}

// --- Session management ---

function generateSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function login(username: string, password: string): { token: string; expiresAt: string } | null {
  const user = getUserByUsername(username);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;

  const token = generateSessionId();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h
  createSession(token, user.id, expiresAt);

  return { token, expiresAt };
}

export function logout(token: string): void {
  deleteSession(token);
}

export function setupAdmin(username: string, password: string): boolean {
  if (getUserCount() > 0) return false; // Admin already exists
  const hash = hashPassword(password);
  createUser(username, hash, 'admin');
  return true;
}

export function isSetupRequired(): boolean {
  return getUserCount() === 0;
}

// --- Middleware ---

/**
 * Auth middleware. Checks for session token in:
 * 1. Authorization: Bearer <token>
 * 2. Cookie: session=<token>
 * 3. Query param: ?token=<token> (for WebSocket)
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth if no users exist (setup mode)
  if (isSetupRequired()) {
    next();
    return;
  }

  // Skip auth for login/setup endpoints
  if (req.path === '/api/auth/login' || req.path === '/api/auth/setup' || req.path === '/api/auth/status') {
    next();
    return;
  }

  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const session = getSession(token);
  if (!session) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  // Attach user info to request
  (req as any).userId = session.user_id;
  (req as any).sessionId = session.id;

  next();
}

function extractToken(req: Request): string | null {
  // Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Cookie
  const cookies = parseCookies(req.headers.cookie || '');
  if (cookies.session) {
    return cookies.session;
  }

  // Query param (for WebSocket)
  if (typeof req.query.token === 'string') {
    return req.query.token;
  }

  return null;
}

function parseCookies(cookie: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of cookie.split(';')) {
    const [key, ...vals] = pair.trim().split('=');
    if (key) result[key.trim()] = vals.join('=').trim();
  }
  return result;
}

/**
 * Rate limiting middleware.
 * Uses IP-based limiting stored in SQLite.
 */
export function rateLimitMiddleware(maxRequests = 60, windowSeconds = 60) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `rate:${ip}`;

    if (!checkRateLimit(key, maxRequests, windowSeconds)) {
      res.status(429).json({
        error: 'Too many requests',
        retryAfter: windowSeconds,
      });
      return;
    }

    next();
  };
}

// Clean up expired sessions periodically
setInterval(() => {
  try { cleanExpiredSessions(); } catch { /* ignore */ }
}, 60 * 60 * 1000); // Every hour
