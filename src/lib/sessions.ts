import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface SessionRecord {
  sessionId: string;
  /**
   * Verified task identifier (only set after a successful provider fetch).
   * `taskProvider` names the plugin that resolved it, so badge rendering
   * can ask the right plugin for a URL.
   */
  taskId?: string;
  taskProvider?: string;
}

// Tolerant on-disk shape: legacy entries may be:
//   - bare strings: "uuid-..."
//   - SessionRecord with jiraKey instead of taskId
// Newly written entries always use { sessionId, taskId?, taskProvider? }.
interface LegacySessionRecord {
  sessionId: string;
  jiraKey?: string;
}
type StoredEntry = SessionRecord | LegacySessionRecord | string;
type SessionMap = Record<string, StoredEntry>;

function ensureSessionsFile(sessionsFile: string): SessionMap {
  mkdirSync(dirname(sessionsFile), { recursive: true });
  if (!existsSync(sessionsFile)) {
    writeFileSync(sessionsFile, '{}\n');
    return {};
  }
  try {
    return JSON.parse(readFileSync(sessionsFile, 'utf-8')) as SessionMap;
  } catch {
    return {};
  }
}

function writeSessions(sessionsFile: string, data: SessionMap): void {
  writeFileSync(sessionsFile, JSON.stringify(data, null, 2) + '\n');
}

function normalize(entry: StoredEntry | undefined): SessionRecord | undefined {
  if (entry === undefined) return undefined;
  if (typeof entry === 'string') return { sessionId: entry };
  // Legacy migration: jiraKey -> taskId + taskProvider="jira"
  if ('jiraKey' in entry && entry.jiraKey && !('taskId' in entry)) {
    return { sessionId: entry.sessionId, taskId: entry.jiraKey, taskProvider: 'jira' };
  }
  return entry as SessionRecord;
}

export function getSession(sessionsFile: string, featureName: string): SessionRecord | undefined {
  const sessions = ensureSessionsFile(sessionsFile);
  return normalize(sessions[featureName]);
}

export function getSessionId(sessionsFile: string, featureName: string): string | undefined {
  return getSession(sessionsFile, featureName)?.sessionId;
}

export function saveSession(sessionsFile: string, featureName: string, record: SessionRecord): void {
  const sessions = ensureSessionsFile(sessionsFile);
  sessions[featureName] = record;
  writeSessions(sessionsFile, sessions);
}

export function saveSessionId(sessionsFile: string, featureName: string, sessionId: string): void {
  const existing = normalize(ensureSessionsFile(sessionsFile)[featureName]);
  saveSession(sessionsFile, featureName, { ...existing, sessionId });
}

export function setTask(
  sessionsFile: string,
  featureName: string,
  task: { id: string; provider: string } | undefined,
): void {
  const sessions = ensureSessionsFile(sessionsFile);
  const existing = normalize(sessions[featureName]);
  if (!existing) return;
  if (task) {
    sessions[featureName] = { ...existing, taskId: task.id, taskProvider: task.provider };
  } else {
    const { taskId: _id, taskProvider: _p, ...rest } = existing;
    sessions[featureName] = rest;
  }
  writeSessions(sessionsFile, sessions);
}

export function removeSessionId(sessionsFile: string, featureName: string): void {
  const sessions = ensureSessionsFile(sessionsFile);
  delete sessions[featureName];
  writeSessions(sessionsFile, sessions);
}

export function generateSessionId(): string {
  return randomUUID();
}
