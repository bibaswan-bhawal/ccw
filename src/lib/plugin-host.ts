/**
 * Plugin host — loads enabled plugins from .ccw.json and provides typed
 * dispatch helpers used by command code (create, ls, rm, ...).
 *
 * Commands talk to the host instead of importing specific plugins directly.
 * That's what lets us swap Jira for Linear/GitHub/etc. without touching the
 * command layer.
 */

import type { ResolvedConfig } from './config.ts';
import type { Plugin, Task, TaskBadge } from './plugin.ts';
import { findBuiltin } from '../plugins/registry.ts';

export interface ActivePlugin {
  plugin: Plugin;
  /** Per-repo config slice from .ccw.json, opaque to the host. */
  config: unknown;
}

export interface PluginHost {
  active: ActivePlugin[];

  /**
   * Find the first task provider whose detectKey matches the feature name.
   * Returns the resolved key plus the plugin, so callers can later call
   * fetchTask without re-walking the list.
   */
  detectTask(featureName: string): { plugin: ActivePlugin; key: string } | undefined;

  /**
   * Fetch a task from a specific provider plugin. Throws if the plugin has
   * no task provider; callers should detectTask first.
   */
  fetchTask(active: ActivePlugin, key: string): Promise<Task>;

  /** Best-effort badge for a task. */
  renderTaskBadge(active: ActivePlugin, task: Task): TaskBadge;

  /**
   * Find an active plugin by name (e.g. "jira") for callers that want to
   * resolve a stored taskProvider back to a live plugin. Returns undefined
   * if the plugin is no longer enabled in this repo.
   */
  findActive(name: string): ActivePlugin | undefined;

  /**
   * Build a clickable badge for a previously-resolved task (just id +
   * provider name from session storage). Returns undefined if the plugin
   * is no longer active or can't derive a URL.
   */
  badgeForStoredTask(taskId: string, providerName: string): TaskBadge | undefined;
}

/**
 * Build a host from a resolved repo config. Order of plugins matches the
 * order they appear in `.ccw.json`'s `plugins` map (object key insertion
 * order is preserved by JSON.parse).
 */
export function createPluginHost(cfg: ResolvedConfig): PluginHost {
  const active: ActivePlugin[] = [];
  for (const [name, config] of Object.entries(cfg.pluginConfigs)) {
    const plugin = findBuiltin(name);
    if (!plugin) {
      // Skip silently — could be a future third-party plugin not bundled.
      continue;
    }
    active.push({ plugin, config });
  }

  return {
    active,

    detectTask(featureName) {
      for (const a of active) {
        if (!a.plugin.task) continue;
        const key = a.plugin.task.detectKey(featureName, a.config);
        if (key) return { plugin: a, key };
      }
      return undefined;
    },

    async fetchTask(active, key) {
      const provider = active.plugin.task;
      if (!provider) {
        throw new Error(`Plugin ${active.plugin.name} has no task provider`);
      }
      return provider.fetchTask(key, active.config);
    },

    renderTaskBadge(active, task) {
      const provider = active.plugin.task;
      if (provider?.renderBadge) return provider.renderBadge(task);
      return { label: task.id, url: task.url ?? '' };
    },

    findActive(name) {
      return active.find((a) => a.plugin.name === name);
    },

    badgeForStoredTask(taskId, providerName) {
      const a = active.find((p) => p.plugin.name === providerName);
      if (!a?.plugin.task) return undefined;
      const url = a.plugin.task.buildTaskUrl?.(taskId, a.config);
      if (!url) return undefined;
      return { label: taskId, url };
    },
  };
}
