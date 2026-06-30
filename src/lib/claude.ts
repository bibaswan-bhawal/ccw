import { closeSync } from 'node:fs';
import type { Task } from './plugin.ts';

/**
 * System prompt for the first session on a worktree: drop in the task
 * context and ask Claude to research + plan before writing code.
 */
export function buildPlanningSystemPrompt(task: Task): string {
  return `The user is working on the following task. Use this context to understand it:

${task.claudeContext}

When the session starts, immediately:
1. Research the codebase to understand the relevant code for this task.
2. Present a concrete implementation plan that includes:
   - A summary of what needs to change and why.
   - The specific files you plan to modify or create.
   - The behaviors that will change.
   - Test cases you will add or modify.
3. Wait for the user's approval before writing any code.`;
}

/**
 * Lighter prompt used when the worktree exists but the saved session
 * doesn't — we still want Claude to know about the task, but no auto-plan.
 */
export function buildContextOnlySystemPrompt(task: Task): string {
  return `The user is working on the following task. Use this context to understand it:

${task.claudeContext}`;
}

/**
 * Reset stdin to a clean state before handing the terminal to the child.
 *
 * Before launching Claude, ccw renders interactive Ink UI (spinners, pickers,
 * the init wizard). Ink puts process.stdin into raw mode and attaches a
 * pull-based `readable` listener to consume keystrokes, and Ink 7 defers part
 * of that teardown to a microtask. We detach any leftover listeners and leave
 * raw mode so the child starts from a clean terminal — without this, the
 * synchronous fallback below inherits a dirty stdin.
 */
export function relinquishStdin(stdin: NodeJS.ReadStream = process.stdin): void {
  if (!stdin.isTTY) return;
  try {
    stdin.removeAllListeners('readable');
    stdin.removeAllListeners('data');
    stdin.setRawMode(false);
    stdin.pause();
  } catch {
    // Best effort — if a platform rejects these, the child still inherits the
    // fd directly and typically recovers terminal control on its own.
  }
}

/**
 * Launch Claude, preferring a PTY proxy and falling back to a synchronous spawn.
 *
 * **PTY path** (default on interactive terminals): Claude runs on a PTY slave
 * while ccw proxies the real terminal to/from the master. Claude never reads
 * ccw's fd 0, so there's no shared-fd contention (no dropped keystrokes), and
 * ccw's event loop stays alive — which a future background-task supervisor
 * needs. Resize is forwarded via a TinyCC-compiled ioctl wrapper (see pty/).
 *
 * **Fallback** (non-TTY, opt-out via CCW_NO_PTY, or any PTY init failure on an
 * untested platform): spawn synchronously. With async spawn + `await`, ccw's
 * event loop would keep a native poll alive on the inherited fd 0, racing the
 * child for input — intermittently dropped keystrokes. spawnSync blocks this
 * thread for the whole session so the child owns the terminal uncontested. ccw
 * does no work while Claude runs, so blocking is free.
 */
export async function launchClaude(args: string[], cwd: string): Promise<number> {
  // The PTY modules import bun:ffi, which only resolves under the Bun runtime.
  // Load them dynamically so non-Bun tooling (e.g. the vitest test runner) can
  // import this file without pulling in bun:ffi.
  const ptyLib = await loadPtyLib();
  if (ptyLib) {
    let pty: { master: number; slave: number } | null = null;
    try {
      const termFd = typeof process.stdout.fd === 'number' ? process.stdout.fd : 1;
      const size = ptyLib.terminalSize(termFd) ?? {
        rows: process.stdout.rows ?? 24,
        cols: process.stdout.columns ?? 80,
      };
      pty = ptyLib.openPty(size.rows, size.cols);
    } catch {
      pty = null; // PTY layer unavailable on this platform → fall back
    }
    if (pty) {
      try {
        const { runClaudeInPty } = await import('./pty/proxy.ts');
        return await runClaudeInPty(pty, args, cwd);
      } catch {
        // Bun.spawn threw before Claude started; clean up and fall back.
        // (Errors *during* the session are handled inside the proxy, so this
        // can't double-spawn a running Claude.)
        for (const fd of [pty.master, pty.slave]) {
          try {
            closeSync(fd);
          } catch {
            /* already closed */
          }
        }
      }
    }
  }
  return launchClaudeSync(args, cwd);
}

async function loadPtyLib(): Promise<typeof import('./pty/index.ts') | null> {
  if (process.env.CCW_NO_PTY) return null;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  try {
    const lib = await import('./pty/index.ts');
    return lib.isPtyAvailable() ? lib : null;
  } catch {
    return null;
  }
}

function launchClaudeSync(args: string[], cwd: string): number {
  relinquishStdin();
  const result = Bun.spawnSync(['claude', ...args], {
    cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return result.exitCode ?? 0;
}
