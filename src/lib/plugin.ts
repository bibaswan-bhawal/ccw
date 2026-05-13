/**
 * Plugin contract for ccw.
 *
 * Plugins extend ccw with capabilities like task lookup (Jira, Linear, ...),
 * environment setup (foreman, docker, ...), and lifecycle hooks. Each plugin
 * declares which capabilities it implements; everything is optional.
 *
 * Built-in plugins live in src/plugins/ and are registered in
 * src/plugins/registry.ts. Configuration per repo lives in .ccw.json under
 * the `plugins` map keyed by plugin name.
 */

import type { ResolvedConfig } from './config.ts';
import type { AnswerMap, InitStep } from './wizard/index.ts';

/**
 * Stable shape returned by a TaskProvider for any kind of work item
 * (Jira ticket, Linear issue, GitHub issue, plain manual description, ...).
 */
export interface Task {
  /** Provider-scoped identifier, e.g. "AHDOC-123" or "linear:BIB-23". */
  id: string;
  /** Short one-line title to display. */
  title: string;
  /** Optional URL for clickable badges. */
  url?: string;
  /** Optional human-readable status (e.g. "In Progress"). */
  status?: string;
  /** Optional longer description. */
  description?: string;
  /**
   * Markdown blob to inject into Claude as system context.
   * Providers convert their structured data into this single text field.
   */
  claudeContext: string;
  /** Provider-specific extras (assignee, labels, etc). Free-form. */
  metadata?: Record<string, unknown>;
}

export interface TaskBadge {
  /** Text shown in `ls`/`rm` (e.g. "AHDOC-123"). */
  label: string;
  /** Target of the OSC 8 hyperlink. */
  url: string;
}

/**
 * A plugin capability that knows how to find and fetch tasks.
 * Examples: Jira, Linear, GitHub Issues.
 */
export interface TaskProvider {
  /**
   * Pull a candidate task key out of a feature name, or undefined if the
   * name doesn't look like one of this provider's tasks.
   */
  detectKey(featureName: string, config: unknown): string | undefined;
  /**
   * Fetch a task by key. Throws if the task does not exist or the call fails;
   * the host catches and downgrades to a warning.
   */
  fetchTask(key: string, config: unknown): Promise<Task>;
  /**
   * Synchronously construct a URL for a task key. Used by `ls` / `rm` to
   * render badges from cached task IDs without re-fetching. Returns
   * undefined if a URL can't be derived from key alone.
   */
  buildTaskUrl?(key: string, config: unknown): string | undefined;
  /**
   * Render a clickable badge from a fetched Task. Defaults to
   * `{ label: task.id, url: task.url }`.
   */
  renderBadge?(task: Task): TaskBadge;
}

/**
 * Background task lifecycle scope (used by Phase 2).
 *
 * - "worktree": shared across all Claude sessions in this worktree.
 *   Reference-counted; last session out tears it down.
 * - "session": tied to a single Claude session. Always spawned fresh,
 *   torn down on Claude exit.
 */
export type BackgroundTaskScope = 'worktree' | 'session';

/**
 * Declaration of a long-running process a plugin wants ccw to manage.
 * Plugins return these from `afterCreate.run`; ccw owns spawn, log redirect,
 * PID tracking, and teardown.
 */
export interface BackgroundTask {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Regex that matches a "ready" line in the log to flip status. */
  readyPattern?: RegExp;
  scope?: BackgroundTaskScope;
}

/**
 * Context passed to lifecycle hooks. Holds enough info that plugins
 * usually don't need to load anything else themselves.
 */
export interface PluginContext {
  cfg: ResolvedConfig;
  worktreeName: string;
  worktreePath: string;
  /** Configuration for this plugin from .ccw.json (already typed by the plugin). */
  config: unknown;
  /** The task associated with this worktree, if a TaskProvider matched. */
  task?: Task;
}

export interface AfterCreateHook {
  /** If true, ccw waits for `run` before launching Claude. */
  blocking: boolean;
  run(ctx: PluginContext): Promise<BackgroundTask[] | void>;
}

/**
 * Setup contract used by the `ccw init` wizard.
 *
 * Plugins declare their setup as a flat list of wizard steps (text inputs,
 * verifications, etc). When the wizard finishes, the plugin's `reduceAnswers`
 * turns the collected answers into the plugin's repo-level config object.
 *
 * Step ids are namespaced by the plugin name (`steps()` should prefix every
 * step id with `<name>:` to avoid collisions across plugins).
 */
export interface PluginInit {
  /**
   * Build the wizard steps for setup. Receives the plugin's existing config
   * (from `.ccw.json`) so it can pre-fill defaults.
   */
  steps(existing: unknown): InitStep[];
  /**
   * Convert the wizard's collected answers into this plugin's config object
   * (the value persisted under `plugins.<name>` in `.ccw.json`).
   *
   * May also persist out-of-band data (e.g. tokens to the credentials store).
   * Should NOT throw — verify steps in `steps()` are the place to validate.
   */
  reduceAnswers(answers: AnswerMap): unknown;
}

export interface Plugin {
  /** Stable identifier, used as the key in .ccw.json's `plugins` map. */
  name: string;
  /** Short human description, shown in `ccw init` plugin picker. */
  description: string;

  /** Optional: declarative wizard setup. Without it, the plugin enables with empty config. */
  init?: PluginInit;

  // --- Capabilities (all optional) ---
  task?: TaskProvider;
  afterCreate?: AfterCreateHook;
  // Future: afterResume, beforeClaudeExit, beforeRemove, etc.
}
