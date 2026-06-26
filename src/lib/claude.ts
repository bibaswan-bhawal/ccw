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
 * Fully hand the controlling TTY to the child before spawning it.
 *
 * Before launching Claude, ccw renders interactive Ink UI (spinners, pickers,
 * the init wizard). Ink puts process.stdin into raw mode and attaches a
 * pull-based `readable` listener to consume keystrokes, and Ink 7 defers part
 * of that teardown to a microtask. Under Bun, remnants of that input handling
 * can survive into the child's lifetime — so the parent (ccw) and the
 * inherited `claude` process both read from the same TTY fd. The kernel splits
 * incoming bytes between the two readers, and the ones the parent grabs are
 * silently dropped. The user sees a laggy input box that misses keystrokes.
 *
 * Running `claude` directly has no such parent, which is why it never repros.
 *
 * We are the boundary that hands the terminal to the child, so stop owning
 * stdin here: detach any leftover listeners, leave raw mode, and pause the
 * stream. ccw exits as soon as the child does, so we never need it back.
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

export async function launchClaude(args: string[], cwd: string): Promise<number> {
  relinquishStdin();
  const proc = Bun.spawn(['claude', ...args], {
    cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await proc.exited;
}
