/**
 * HITL Approval System Tests
 *
 * Uses Node built-in assert + in-memory SQLite to test:
 * - Approval request lifecycle (create, resolve, timeout)
 * - Approval rules (defaults, custom, upsert)
 * - Manager logic (checkApprovalRequired, respondToApproval)
 *
 * Run: npx tsx tests/hitl.test.ts
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// Set up temp DB before any imports that read config
const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hitl-test-'));
const testDbPath = path.join(testDbDir, 'test.db');
process.env.DB_PATH = testDbPath;
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

// Now import HITL modules
import {
  initHitlSchema,
  createApprovalRequest,
  resolveApproval,
  getApprovalRequest,
  getPendingApprovals,
  getApprovalStats,
  getApprovalRule,
  getAllApprovalRules,
  upsertApprovalRule,
  deleteApprovalRule,
} from '../src/agent/hitl/db';

import {
  checkApprovalRequired,
  requestApproval,
  respondToApproval,
} from '../src/agent/hitl/manager';

import {
  DEFAULT_TOOL_RISK,
  DEFAULT_REQUIRE_APPROVAL,
  DEFAULT_TIMEOUT,
} from '../src/agent/hitl/types';

// Initialize schema
initHitlSchema();

// ============================================================
// DB Layer Tests
// ============================================================

describe('HITL DB: Approval Requests', () => {
  test('createApprovalRequest creates a pending request', () => {
    const req = createApprovalRequest({
      runId: 1,
      conversationId: 'conv-1',
      toolName: 'run_script',
      toolInput: { command: 'ls -la' },
      riskLevel: 'high',
      timeoutSeconds: 300,
    });

    assert.ok(req.id, 'should have an id');
    assert.equal(req.status, 'pending');
    assert.equal(req.toolName, 'run_script');
    assert.equal(req.riskLevel, 'high');
    assert.deepEqual(req.toolInput, { command: 'ls -la' });
    assert.ok(req.requestedAt);
    assert.ok(req.timeoutAt);
  });

  test('getApprovalRequest retrieves by id', () => {
    const req = createApprovalRequest({
      runId: 2,
      conversationId: 'conv-2',
      toolName: 'http_request',
      toolInput: { url: 'https://example.com' },
      riskLevel: 'medium',
      timeoutSeconds: 60,
    });

    const found = getApprovalRequest(req.id);
    assert.ok(found);
    assert.equal(found.id, req.id);
    assert.equal(found.toolName, 'http_request');
  });

  test('resolveApproval changes status', () => {
    const req = createApprovalRequest({
      runId: 3,
      conversationId: 'conv-3',
      toolName: 'run_script',
      toolInput: { command: 'rm -rf /' },
      riskLevel: 'critical',
      timeoutSeconds: 600,
    });

    resolveApproval(req.id, 'rejected', 'Too dangerous', 'admin');
    const found = getApprovalRequest(req.id);
    assert.ok(found);
    assert.equal(found.status, 'rejected');
    assert.equal(found.reason, 'Too dangerous');
    assert.equal(found.respondedBy, 'admin');
    assert.ok(found.respondedAt);
  });

  test('getPendingApprovals only returns pending', () => {
    // Create one pending and one resolved
    const a = createApprovalRequest({
      runId: 4,
      conversationId: 'conv-4',
      toolName: 'web_browse',
      toolInput: {},
      riskLevel: 'high',
      timeoutSeconds: 300,
    });

    const b = createApprovalRequest({
      runId: 5,
      conversationId: 'conv-5',
      toolName: 'run_script',
      toolInput: {},
      riskLevel: 'high',
      timeoutSeconds: 300,
    });

    resolveApproval(b.id, 'approved');

    const pending = getPendingApprovals();
    const pendingIds = pending.map(p => p.id);
    assert.ok(pendingIds.includes(a.id), 'should include the pending one');
    assert.ok(!pendingIds.includes(b.id), 'should not include the resolved one');
  });

  test('getApprovalStats returns correct counts', () => {
    const stats = getApprovalStats();
    assert.ok(stats.pending >= 0);
    assert.ok(stats.approved >= 0);
    assert.ok(stats.rejected >= 0);
  });

  test('createApprovalRequest with optional channelId and groupId', () => {
    const req = createApprovalRequest({
      runId: 6,
      conversationId: 'conv-6',
      channelId: 'ch-1',
      groupId: 'grp-1',
      toolName: 'run_script',
      toolInput: { command: 'echo hello' },
      riskLevel: 'high',
      timeoutSeconds: 120,
    });

    assert.equal(req.channelId, 'ch-1');
    assert.equal(req.groupId, 'grp-1');

    const found = getApprovalRequest(req.id);
    assert.ok(found);
    assert.equal(found.channelId, 'ch-1');
    assert.equal(found.groupId, 'grp-1');
  });
});

// ============================================================
// Approval Rules Tests
// ============================================================

describe('HITL DB: Approval Rules', () => {
  test('upsertApprovalRule creates a new rule', () => {
    const rule = upsertApprovalRule({
      toolName: 'test_tool_1',
      riskLevel: 'critical',
      requireApproval: true,
      timeoutSeconds: 120,
      timeoutAction: 'reject',
    });

    assert.equal(rule.toolName, 'test_tool_1');
    assert.equal(rule.riskLevel, 'critical');
    assert.equal(rule.requireApproval, true);
    assert.equal(rule.timeoutSeconds, 120);
    assert.equal(rule.timeoutAction, 'reject');
  });

  test('upsertApprovalRule updates existing rule', () => {
    upsertApprovalRule({ toolName: 'test_tool_2', riskLevel: 'low' });
    upsertApprovalRule({ toolName: 'test_tool_2', riskLevel: 'high', requireApproval: true });

    const rule = getApprovalRule('test_tool_2');
    assert.ok(rule);
    assert.equal(rule.riskLevel, 'high');
  });

  test('getAllApprovalRules returns all rules', () => {
    const rules = getAllApprovalRules();
    assert.ok(rules.length >= 2, 'should have at least the rules we created');
  });

  test('deleteApprovalRule removes a rule', () => {
    upsertApprovalRule({ toolName: 'delete_me' });
    assert.ok(getApprovalRule('delete_me'));

    const deleted = deleteApprovalRule('delete_me');
    assert.ok(deleted);
    assert.equal(getApprovalRule('delete_me'), undefined);
  });

  test('deleteApprovalRule returns false for non-existent', () => {
    const deleted = deleteApprovalRule('non_existent_tool_xyz');
    assert.equal(deleted, false);
  });
});

// ============================================================
// Manager Logic Tests
// ============================================================

describe('HITL Manager: checkApprovalRequired', () => {
  test('low risk tools do not require approval by default', () => {
    const result = checkApprovalRequired('web_browse');
    assert.equal(result.required, false);
    assert.equal(result.riskLevel, 'low');
  });

  test('high risk tools require approval by default', () => {
    const result = checkApprovalRequired('run_script');
    assert.equal(result.required, true);
    assert.equal(result.riskLevel, 'high');
  });

  test('medium risk tools do not require approval by default', () => {
    const result = checkApprovalRequired('http_request');
    assert.equal(result.required, false);
    assert.equal(result.riskLevel, 'medium');
  });

  test('unknown tools get medium risk by default', () => {
    const result = checkApprovalRequired('totally_new_tool');
    assert.equal(result.riskLevel, 'medium');
    assert.equal(result.required, false);
  });

  test('custom rule overrides defaults', () => {
    upsertApprovalRule({
      toolName: 'web_browse',
      riskLevel: 'critical',
      requireApproval: true,
      autoApprove: false,
    });

    const result = checkApprovalRequired('web_browse');
    assert.equal(result.required, true);
    assert.equal(result.riskLevel, 'critical');

    // Clean up
    deleteApprovalRule('web_browse');
  });

  test('autoApprove bypasses approval requirement', () => {
    upsertApprovalRule({
      toolName: 'run_script',
      riskLevel: 'high',
      requireApproval: true,
      autoApprove: true,
    });

    const result = checkApprovalRequired('run_script');
    assert.equal(result.required, false); // autoApprove overrides requireApproval

    // Clean up
    deleteApprovalRule('run_script');
  });
});

describe('HITL Manager: respondToApproval', () => {
  test('respondToApproval resolves waiting promise', async () => {
    // requestApproval now returns { approvalId, promise }
    const { approvalId, promise } = requestApproval({
      runId: 100,
      conversationId: 'conv-100',
      toolName: 'run_script',
      toolInput: { command: 'echo test' },
      riskLevel: 'high',
      timeoutSeconds: 60,
      timeoutAction: 'reject',
    });

    assert.ok(approvalId, 'should return an approvalId');

    // Use the returned ID directly — no DB lookup needed
    const ok = respondToApproval(approvalId, true, 'Looks safe', 'tester');
    assert.ok(ok, 'respondToApproval should return true');

    const result = await promise;
    assert.equal(result.approved, true);
    assert.equal(result.reason, 'Looks safe');
    assert.equal(result.respondedBy, 'tester');
  });

  test('respondToApproval with rejection', async () => {
    const { approvalId, promise } = requestApproval({
      runId: 101,
      conversationId: 'conv-101',
      toolName: 'run_script',
      toolInput: { command: 'rm -rf /' },
      riskLevel: 'critical',
      timeoutSeconds: 60,
      timeoutAction: 'reject',
    });

    const ok = respondToApproval(approvalId, false, 'Dangerous command');
    assert.ok(ok);

    const result = await promise;
    assert.equal(result.approved, false);
    assert.equal(result.reason, 'Dangerous command');
  });

  test('respondToApproval returns false for non-existent id', () => {
    const ok = respondToApproval('non-existent-id', true);
    assert.equal(ok, false);
  });
});

describe('HITL Manager: timeout behavior', () => {
  test('approval times out with reject action', async () => {
    const { promise } = requestApproval({
      runId: 200,
      conversationId: 'conv-200',
      toolName: 'run_script',
      toolInput: { command: 'sleep 100' },
      riskLevel: 'high',
      timeoutSeconds: 1, // 1 second timeout for test
      timeoutAction: 'reject',
    });

    const result = await promise;
    assert.equal(result.approved, false);
    assert.ok(result.reason?.includes('timed out'));
  });

  test('approval times out with approve action', async () => {
    const { promise } = requestApproval({
      runId: 201,
      conversationId: 'conv-201',
      toolName: 'http_request',
      toolInput: { url: 'https://safe.example.com' },
      riskLevel: 'medium',
      timeoutSeconds: 1,
      timeoutAction: 'approve',
    });

    const result = await promise;
    assert.equal(result.approved, true);
    assert.ok(result.reason?.includes('timed out'));
  });
});

describe('HITL Types: Default configurations', () => {
  test('DEFAULT_TOOL_RISK covers built-in tools', () => {
    assert.equal(DEFAULT_TOOL_RISK['web_browse'], 'low');
    assert.equal(DEFAULT_TOOL_RISK['run_script'], 'high');
    assert.equal(DEFAULT_TOOL_RISK['http_request'], 'medium');
    assert.equal(DEFAULT_TOOL_RISK['delegate_task'], 'medium');
    assert.equal(DEFAULT_TOOL_RISK['broadcast_event'], 'low');
    assert.equal(DEFAULT_TOOL_RISK['query_agents'], 'low');
  });

  test('DEFAULT_REQUIRE_APPROVAL is correct per risk level', () => {
    assert.equal(DEFAULT_REQUIRE_APPROVAL['low'], false);
    assert.equal(DEFAULT_REQUIRE_APPROVAL['medium'], false);
    assert.equal(DEFAULT_REQUIRE_APPROVAL['high'], true);
    assert.equal(DEFAULT_REQUIRE_APPROVAL['critical'], true);
  });

  test('DEFAULT_TIMEOUT increases with risk level', () => {
    assert.ok(DEFAULT_TIMEOUT['low'] <= DEFAULT_TIMEOUT['medium']);
    assert.ok(DEFAULT_TIMEOUT['medium'] <= DEFAULT_TIMEOUT['high']);
    assert.ok(DEFAULT_TIMEOUT['high'] <= DEFAULT_TIMEOUT['critical']);
  });
});

console.log('\n All HITL tests completed!\n');
