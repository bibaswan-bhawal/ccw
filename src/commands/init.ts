import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfigForInit, writeRepoConfig, type RepoConfig } from '../lib/config.ts';
import { runWizard, type AnswerMap, type InitStep } from '../lib/wizard/index.ts';
import { BUILTIN_PLUGINS, findBuiltin } from '../plugins/registry.ts';
import { ui } from '../lib/ui.ts';

const REPO_SECTION = 'Repository';
const PLUGINS_SECTION = 'Plugins';
const ID = {
  worktreeDir: 'repo:worktree_dir',
  appSubdir: 'repo:app_subdir',
  baseBranch: 'repo:base_branch',
  plugins: 'repo:plugins',
} as const;

export async function runInit(): Promise<void> {
  const cfg = loadConfigForInit();

  const raw: RepoConfig = existsSync(cfg.repoConfigPath)
    ? (JSON.parse(readFileSync(cfg.repoConfigPath, 'utf-8')) as RepoConfig)
    : {};

  // --- Repo-level steps ---
  const defaultWorktreeDir = join(dirname(cfg.gitRoot), `${cfg.repoName}_worktrees`);

  const repoSteps: InitStep[] = [
    {
      id: ID.worktreeDir,
      section: REPO_SECTION,
      type: 'text',
      question: 'Worktree directory',
      hint: 'Where ccw creates new worktrees. A sibling folder to your repo keeps things tidy.',
      default: raw.worktree_dir || defaultWorktreeDir,
      required: true,
    },
    {
      id: ID.appSubdir,
      section: REPO_SECTION,
      type: 'text',
      question: 'App subdirectory',
      hint: 'For monorepos, the subdirectory inside each worktree where Claude should be launched (e.g. apps/property). Leave blank for single-app repos.',
      default: raw.app_subdir,
    },
    {
      id: ID.baseBranch,
      section: REPO_SECTION,
      type: 'text',
      question: 'Base branch',
      hint: 'New worktrees branch off this. Usually main or master.',
      default: raw.base_branch || cfg.baseBranch,
      required: true,
    },
  ];

  // --- Plugin selection step ---
  const currentlyEnabled = new Set(Object.keys(cfg.pluginConfigs));
  const pluginSelectStep: InitStep | undefined =
    BUILTIN_PLUGINS.length > 0
      ? {
          id: ID.plugins,
          section: PLUGINS_SECTION,
          type: 'multiselect',
          question: 'Enable plugins',
          hint: 'Plugins extend ccw — task lookup, environment setup, lifecycle hooks. Toggle with Space; Enter to continue.',
          options: BUILTIN_PLUGINS.map((p) => ({
            value: p.name,
            label: p.name,
            description: p.description,
          })),
          initialSelected: BUILTIN_PLUGINS.filter((p) => currentlyEnabled.has(p.name)).map((p) => p.name),
        }
      : undefined;

  // Two passes because the second pass's step list depends on the user's
  // plugin selection from the first pass.
  const firstPass = await runWizard({
    steps: [...repoSteps, ...(pluginSelectStep ? [pluginSelectStep] : [])],
    title: cfg.gitRoot,
    subtitle: 'Configure ccw for this repository',
  });
  if (firstPass.aborted) {
    ui.hint('Aborted. No changes made.');
    return;
  }

  const selectedPluginNames = (firstPass.answers[ID.plugins] as string[] | undefined) ?? [];

  let pluginAnswers: AnswerMap = {};
  if (selectedPluginNames.length > 0) {
    const pluginSteps: InitStep[] = [];
    for (const name of selectedPluginNames) {
      const plugin = findBuiltin(name);
      if (!plugin?.init) continue;
      const existing = cfg.pluginConfigs[name];
      pluginSteps.push(...plugin.init.steps(existing));
    }

    if (pluginSteps.length > 0) {
      const secondPass = await runWizard({
        steps: pluginSteps,
        title: cfg.gitRoot,
        subtitle: 'Configure plugins',
      });
      if (secondPass.aborted) {
        ui.hint('Aborted plugin setup. Repo-level changes will not be saved.');
        return;
      }
      pluginAnswers = secondPass.answers;
    }
  }

  // --- Reduce plugin answers into config objects ---
  const pluginConfigs: Record<string, unknown> = {};
  for (const name of selectedPluginNames) {
    const plugin = findBuiltin(name);
    if (!plugin) continue;
    if (!plugin.init) {
      pluginConfigs[name] = cfg.pluginConfigs[name] ?? {};
      continue;
    }
    pluginConfigs[name] = plugin.init.reduceAnswers(pluginAnswers);
  }

  // --- Persist ---
  const config: RepoConfig = {
    worktree_dir: (firstPass.answers[ID.worktreeDir] as string) ?? '',
    app_subdir: (firstPass.answers[ID.appSubdir] as string | undefined) ?? '',
    base_branch: (firstPass.answers[ID.baseBranch] as string) ?? '',
    plugins: pluginConfigs,
  };

  const path = writeRepoConfig(cfg.gitRoot, config);
  ui.blank();
  ui.success(`Saved config to ${ui.cyan(path)}`);
  ui.hint('Stored outside the repo, so nothing in the working tree changes.');

  ui.blank();
  ui.success(`Done! You can now use ${ui.cyan('ccw <feature-name>')} in this repo.`);
}
