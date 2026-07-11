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
    ui.error(`Worktree not found: ${worktreePath}`);
    ui.hint("Run 'ccw ls' to see active worktrees.");
    process.exit(1);
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

export async function runEnvStart(featureName: string | undefined): Promise<void> {
  const { handle } = resolveHandle(featureName);
  if (!hasEnvHooks(handle)) {
    ui.error('No env hooks for this repo (.ccw/hooks/env-start).');
    process.exit(1);
  }
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
    ui.success(`Environment starting. Check with ${ui.bold('ccw env status')}.`);
  }
}

export async function runEnvStop(featureName: string | undefined): Promise<void> {
  const { handle } = resolveHandle(featureName);
  await stopEnvironment(handle);
  ui.success('Environment stopped.');
}

export async function runEnvRestart(featureName: string | undefined): Promise<void> {
  const { handle } = resolveHandle(featureName);
  await stopEnvironment(handle);
  const result = await startEnvironment(handle);
  if (result.warning) ui.warn(result.warning);
  if (result.started) ui.success(`Environment restarting. Check with ${ui.bold('ccw env status')}.`);
  else ui.warn('Nothing started — is there an env-start hook?');
}
