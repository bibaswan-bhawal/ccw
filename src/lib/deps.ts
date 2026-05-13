import { ui } from './ui.ts';

export function checkDependencies(): void {
  const required = ['git', 'claude'];
  const missing: string[] = [];

  for (const cmd of required) {
    const proc = Bun.spawnSync(['which', cmd], { stderr: 'pipe', stdout: 'pipe' });
    if (proc.exitCode !== 0) {
      missing.push(cmd);
    }
  }

  if (missing.length > 0) {
    ui.error(`Missing required commands: ${missing.join(', ')}`);
    process.exit(1);
  }
}
