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

export async function launchClaude(args: string[], cwd: string): Promise<number> {
  const proc = Bun.spawn(['claude', ...args], {
    cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await proc.exited;
}
