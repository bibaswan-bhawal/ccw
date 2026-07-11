import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, type ResolvedConfig } from '../lib/config.ts';
import {
  createEnvHandle,
  getStatus,
  hasEnvHooks,
  runSetup,
  startEnvironment,
  stopEnvironment,
  type EnvHandle,
} from '../lib/env/lifecycle.ts';
import { envPaths } from '../lib/env/paths.ts';
import { ui } from '../lib/ui.ts';

/**
 * Resolve which worktree we're operating on: explicit argument wins, else
 * derive from cwd when it's inside the repo's worktree dir.
 */
function resolveHandle(featureName: string | undefined): { cfg: ResolvedConfig; handle: EnvHandle } {
  const cfg = loadConfig();
  let name = featureName;
  if (!name) {
    const rel = relative(cfg.worktreeDir, process.cwd());
    if (!rel.startsWith('..') && rel !== '') {
      name = rel.split(sep)[0];
    }
  }
  if (!name) {
    ui.error('Not inside a ccw worktree.');
    ui.hint('Usage: ccw env <status|logs|start|stop|restart> [feature-name]');
    process.exit(1);
  }
  const worktreePath = join(cfg.worktreeDir, name);
  if (!existsSync(worktreePath)) {
    // The worktree itself may be gone (removed by hand, or `ccw rm` failed
    // partway) while its environment state survives — that's exactly the
    // orphaned case this needs to let through so `ccw env stop`/`status`
    // can still reap it: repo-level hooks won't be found (they live in the
    // now-missing worktree), but user-level hooks (~/.ccw/repos/.../hooks)
    // still resolve, and group-kill by the recorded pid needs no hooks at
    // all. Only bail out when there's truly nothing to act on.
    const stateFile = envPaths(cfg.repoConfigPath, name).stateFile;
    if (!existsSync(stateFile)) {
      ui.error(`No worktree or environment found for '${name}'.`);
      ui.hint("Run 'ccw ls' to see active worktrees.");
      process.exit(1);
    }
  }
  return { cfg, handle: createEnvHandle(cfg, name, worktreePath) };
}

export async function runEnvStatus(featureName: string | undefined, opts: { json?: boolean }): Promise<void> {
  const { handle } = resolveHandle(featureName);
  const status = await getStatus(handle);

  if (opts.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (!status.exists) {
    ui.info(`No environment for ${ui.bold(handle.featureName)}.`);
    if (!hasEnvHooks(handle)) {
      ui.hint('No env hooks found (.ccw/hooks/env-start). See README "Isolated environments".');
    } else {
      ui.hint(`Run ${ui.bold('ccw env start')} to start it.`);
    }
    return;
  }

  const phaseColor =
    status.phase === 'running' ? ui.green : status.phase === 'failed' ? ui.red : ui.yellow;
  ui.heading(`Environment for ${handle.featureName}`);
  console.log(`  phase     ${phaseColor(status.phase)}`);
  console.log(`  ready     ${status.ready === undefined ? ui.dim('unknown') : status.ready ? ui.green('yes') : ui.yellow('not yet')}`);
  console.log(`  sessions  ${status.attachedSessions}`);
  if (status.slot !== undefined) console.log(`  slot      ${status.slot}`);
  console.log(`  log       ${ui.dim(status.logFile)}`);
  const services = (status.hookStatus as { services?: Array<{ name?: string; url?: string; status?: string }> })
    ?.services;
  if (Array.isArray(services)) {
    for (const svc of services) {
      console.log(`  service   ${svc.name ?? '?'} ${svc.url ? ui.cyan(svc.url) : ''} ${svc.status ? ui.dim(svc.status) : ''}`);
    }
  }
  for (const w of status.warnings) ui.warn(w);
  if (status.phase === 'failed') {
    ui.hint(`Check ${ui.bold('ccw env logs')} and retry with ${ui.bold('ccw env restart')}.`);
  }
}

export async function runEnvLogs(
  featureName: string | undefined,
  opts: { lines?: string; follow?: boolean },
): Promise<void> {
  const { handle } = resolveHandle(featureName);
  if (!existsSync(handle.paths.logFile)) {
    ui.info('No environment log yet.');
    return;
  }
  const count = Number(opts.lines ?? '50') || 50;
  if (opts.follow) {
    // tail -f owns the terminal until Ctrl+C; fine — this is interactive use.
    spawnSync('tail', ['-n', String(count), '-f', handle.paths.logFile], { stdio: 'inherit' });
    return;
  }
  const lines = readFileSync(handle.paths.logFile, 'utf-8').split('\n');
  console.log(lines.slice(Math.max(0, lines.length - count - 1)).join('\n'));
}

/**
 * Shared by `ccw env start` and `ccw env restart`: run setup (if needed,
 * retrying a previously-failed setup) then start. Restart used to skip this
 * and call startEnvironment directly, which meant a broken env-setup was
 * never retried on restart and hook-validation warnings never surfaced.
 */
async function runSetupThenStart(handle: EnvHandle, startingLabel: string): Promise<void> {
  const setup = await runSetup(handle);
  if (setup.warning) ui.warn(setup.warning);
  if (!setup.ok) process.exit(1);
  const result = await startEnvironment(handle);
  if (result.warning) ui.warn(result.warning);
  if (result.alreadyRunning) {
    ui.info('Environment already running.');
    return;
  }
  if (result.started) {
    ui.success(`${startingLabel} Check with ${ui.bold('ccw env status')}.`);
  } else if (!result.warning) {
    ui.warn('Nothing started — is there an env-start hook?');
  }
}

export async function runEnvStart(featureName: string | undefined): Promise<void> {
  const { handle } = resolveHandle(featureName);
  if (!hasEnvHooks(handle)) {
    ui.error('No env hooks for this repo (.ccw/hooks/env-start).');
    process.exit(1);
  }
  await runSetupThenStart(handle, 'Environment starting.');
}

export async function runEnvStop(featureName: string | undefined): Promise<void> {
  const { handle } = resolveHandle(featureName);
  await stopEnvironment(handle);
  ui.success('Environment stopped.');
}

export async function runEnvRestart(featureName: string | undefined): Promise<void> {
  const { handle } = resolveHandle(featureName);
  await stopEnvironment(handle);
  await runSetupThenStart(handle, 'Environment restarting.');
}
