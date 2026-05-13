import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSessionId,
  getSession,
  getSessionId,
  removeSessionId,
  saveSessionId,
  setTask,
} from '../src/lib/sessions.ts';

let tmp: string;
let sessionsFile: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccw-sessions-'));
  sessionsFile = join(tmp, 'sessions.json');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('sessions', () => {
  test('returns undefined for unknown feature', () => {
    expect(getSessionId(sessionsFile, 'nothing')).toBeUndefined();
  });

  test('saves and reads back a session id', () => {
    saveSessionId(sessionsFile, 'feat-a', 'uuid-123');
    expect(getSessionId(sessionsFile, 'feat-a')).toBe('uuid-123');
  });

  test('overwrites existing session id', () => {
    saveSessionId(sessionsFile, 'feat-a', 'uuid-1');
    saveSessionId(sessionsFile, 'feat-a', 'uuid-2');
    expect(getSessionId(sessionsFile, 'feat-a')).toBe('uuid-2');
  });

  test('removeSessionId removes the mapping', () => {
    saveSessionId(sessionsFile, 'feat-a', 'uuid-1');
    removeSessionId(sessionsFile, 'feat-a');
    expect(getSessionId(sessionsFile, 'feat-a')).toBeUndefined();
  });

  test('generateSessionId produces a valid UUID', () => {
    const id = generateSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('multiple features coexist', () => {
    saveSessionId(sessionsFile, 'a', '1');
    saveSessionId(sessionsFile, 'b', '2');
    saveSessionId(sessionsFile, 'c', '3');
    removeSessionId(sessionsFile, 'b');
    expect(getSessionId(sessionsFile, 'a')).toBe('1');
    expect(getSessionId(sessionsFile, 'b')).toBeUndefined();
    expect(getSessionId(sessionsFile, 'c')).toBe('3');
  });

  test('setTask attaches a task to an existing session', () => {
    saveSessionId(sessionsFile, 'feat', 'uuid-1');
    setTask(sessionsFile, 'feat', { id: 'AHDOC-123', provider: 'jira' });
    const session = getSession(sessionsFile, 'feat');
    expect(session?.sessionId).toBe('uuid-1');
    expect(session?.taskId).toBe('AHDOC-123');
    expect(session?.taskProvider).toBe('jira');
  });

  test('setTask is a no-op when no session exists', () => {
    setTask(sessionsFile, 'feat', { id: 'AHDOC-123', provider: 'jira' });
    expect(getSession(sessionsFile, 'feat')).toBeUndefined();
  });

  test('setTask(undefined) clears the task', () => {
    saveSessionId(sessionsFile, 'feat', 'uuid-1');
    setTask(sessionsFile, 'feat', { id: 'AHDOC-123', provider: 'jira' });
    setTask(sessionsFile, 'feat', undefined);
    const session = getSession(sessionsFile, 'feat');
    expect(session?.sessionId).toBe('uuid-1');
    expect(session?.taskId).toBeUndefined();
    expect(session?.taskProvider).toBeUndefined();
  });

  test('legacy string entries are read transparently', () => {
    // Simulate an older sessions.json with bare string values.
    writeFileSync(sessionsFile, JSON.stringify({ legacy: 'old-uuid' }) + '\n');
    expect(getSessionId(sessionsFile, 'legacy')).toBe('old-uuid');
    expect(getSession(sessionsFile, 'legacy')).toEqual({ sessionId: 'old-uuid' });
  });

  test('legacy jiraKey entries migrate to taskId on read', () => {
    writeFileSync(sessionsFile, JSON.stringify({ legacy: { sessionId: 'old-uuid', jiraKey: 'AHDOC-1' } }) + '\n');
    const session = getSession(sessionsFile, 'legacy');
    expect(session?.sessionId).toBe('old-uuid');
    expect(session?.taskId).toBe('AHDOC-1');
    expect(session?.taskProvider).toBe('jira');
  });
});
