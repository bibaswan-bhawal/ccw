export class GitError extends Error {}

// Sync helpers: fast operations (rev-parse, show-ref, etc) used in hot paths
// where async ceremony isn't worth it.
export function runGit(args: string[], cwd?: string): string {
  const proc = Bun.spawnSync(['git', ...args], { cwd, stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new GitError(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

export function tryGit(args: string[], cwd?: string): string | undefined {
  const proc = Bun.spawnSync(['git', ...args], { cwd, stderr: 'pipe' });
  if (proc.exitCode !== 0) return undefined;
  return proc.stdout.toString().trim();
}

// Async helpers: use these for operations that can take seconds (fetch,
// worktree add/remove, branch delete). Sync spawn would block Ink's render
// loop and freeze the spinner.
async function runGitAsync(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stderr: 'pipe', stdout: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new GitError(`git ${args.join(' ')} failed: ${stderr}`);
  }
  return stdout.trim();
}

async function tryGitAsync(args: string[], cwd?: string): Promise<string | undefined> {
  try {
    return await runGitAsync(args, cwd);
  } catch {
    return undefined;
  }
}

export function getGitRoot(cwd: string = process.cwd()): string {
  const root = tryGit(['rev-parse', '--show-toplevel'], cwd);
  if (!root) {
    throw new GitError('not inside a git repository');
  }
  return root;
}

export function getDefaultBranch(gitRoot: string): string | undefined {
  const head = tryGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], gitRoot);
  if (!head) return undefined;
  return head.replace(/^refs\/remotes\/origin\//, '');
}

export function branchExists(gitRoot: string, branchName: string): boolean {
  const result = tryGit(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], gitRoot);
  return result !== undefined;
}

export function refExists(gitRoot: string, ref: string): boolean {
  const result = tryGit(['rev-parse', '--verify', ref], gitRoot);
  return result !== undefined;
}

export async function fetchBranch(gitRoot: string, branch: string): Promise<void> {
  await tryGitAsync(['fetch', 'origin', branch, '--quiet'], gitRoot);
}

export async function createWorktree(
  gitRoot: string,
  worktreePath: string,
  branchName: string,
  baseRef: string,
): Promise<void> {
  if (branchExists(gitRoot, branchName)) {
    await runGitAsync(['worktree', 'add', worktreePath, branchName], gitRoot);
  } else {
    await runGitAsync(['worktree', 'add', '-b', branchName, worktreePath, baseRef], gitRoot);
  }
}

export async function removeWorktree(gitRoot: string, worktreePath: string): Promise<void> {
  await runGitAsync(['worktree', 'remove', worktreePath], gitRoot);
}

export function pruneWorktrees(gitRoot: string): void {
  tryGit(['worktree', 'prune'], gitRoot);
}

export async function deleteBranch(gitRoot: string, branchName: string): Promise<void> {
  await runGitAsync(['branch', '-D', branchName], gitRoot);
}

export interface WorktreeEntry {
  path: string;
  sha: string;
  branch: string;
}

export function listWorktrees(gitRoot: string): WorktreeEntry[] {
  const output = tryGit(['worktree', 'list'], gitRoot);
  if (!output) return [];

  const entries: WorktreeEntry[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    // Format: <path> <sha> [<branch>]
    const match = line.match(/^(\S+)\s+([0-9a-f]+)\s+\[([^\]]+)\]/);
    if (match) {
      entries.push({
        path: match[1] ?? '',
        sha: match[2] ?? '',
        branch: match[3] ?? '',
      });
    }
  }
  return entries;
}
