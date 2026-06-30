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
 * raw mode so the child starts from a clean terminal — but this alone is not
 * enough (see launchClaude): a paused JS stream doesn't stop Bun's native poll
 * on fd 0 while our event loop keeps spinning.
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
 * Launch Claude and block until it exits.
 *
 * We spawn *synchronously* on purpose. With async spawn + `await proc.exited`,
 * ccw's event loop keeps running for the entire Claude session, and Bun's
 * process.stdin (a TTY handle on fd 0) keeps a native poll on that fd alive
 * even when the JS stream is paused. Since the inherited `claude` reads the
 * same fd 0, the two readers race and the kernel occasionally hands a byte to
 * ccw instead of Claude — silently dropped, surfacing as an input box that
 * intermittently misses keystrokes. Running `claude` directly has no such
 * parent, which is why it never reproduces there.
 *
 * spawnSync blocks this thread in the syscall for the whole session, so our
 * event loop never spins and never polls fd 0 — Claude gets uncontested
 * ownership of the terminal. ccw does no work while Claude runs (both call
 * sites just exit afterward), so blocking is free.
 */
export function launchClaude(args: string[], cwd: string): number {
  relinquishStdin();
  const result = Bun.spawnSync(['claude', ...args], {
    cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return result.exitCode ?? 0;
}
