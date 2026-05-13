#!/usr/bin/env bun
import { Command, CommanderError } from 'commander';
import { checkDependencies } from './lib/deps.ts';
import { runInit } from './commands/init.ts';
import { runCreate } from './commands/create.ts';
import { runLs, runPicker } from './commands/ls.ts';
import { runRm } from './commands/rm.ts';
import { runConfigGet, runConfigInteractive, runConfigPath, runConfigSet, runConfigUnset } from './commands/config.ts';
import { ConfigMissingError } from './lib/config.ts';
import { RESERVED_NAMES, isReservedName } from './lib/reserved.ts';
import { findClosestMatch } from './lib/suggest.ts';
import { ui } from './lib/ui.ts';

// Read version at build time — Bun embeds the package.json value.
import pkg from '../package.json' with { type: 'json' };

const KNOWN_COMMANDS = ['init', 'ls', 'list', 'rm', 'remove', 'config', 'help', 'version'];

async function main(): Promise<void> {
  checkDependencies();

  const program = new Command();

  program
    .name('ccw')
    .description('Claude Code Worktree — manage git worktrees with persistent Claude Code sessions')
    .version(pkg.version)
    .showHelpAfterError()
    .showSuggestionAfterError(false) // we provide our own suggestions
    .configureOutput({
      outputError: (str, write) => write(ui.red(str)),
    });

  program
    .command('init')
    .description('Initialize ccw for the current repo (interactive)')
    .action(async () => {
      await runInit();
    });

  program
    .command('ls')
    .alias('list')
    .description('List active worktrees (interactive picker by default)')
    .option('--pipe', 'Print plain list and exit (for scripting). Also triggered when stdout is not a TTY.')
    .action(async (opts: { pipe?: boolean }) => {
      await runLs({ pipe: opts.pipe });
    });

  program
    .command('rm [feature-name]')
    .alias('remove')
    .description('Remove a worktree and its session (interactive multi-select if no name given)')
    .action(async (featureName: string | undefined) => {
      await runRm(featureName);
    });

  program
    .command('config')
    .description('Edit global ccw settings (interactive). Use flags for scripting.')
    .option('--get <key>', 'Print a single resolved setting and exit')
    .option('--set <key=value>', 'Persist a setting and exit (e.g. --set update_channel=prerelease)')
    .option('--unset <key>', 'Remove a stored override and exit')
    .option('--path', 'Print the absolute path to the settings file and exit')
    .action(async (opts: { get?: string; set?: string; unset?: string; path?: boolean }) => {
      if (opts.path) {
        runConfigPath();
        return;
      }
      if (opts.get) {
        runConfigGet(opts.get);
        return;
      }
      if (opts.unset) {
        runConfigUnset(opts.unset);
        return;
      }
      if (opts.set) {
        const eq = opts.set.indexOf('=');
        if (eq < 0) {
          ui.error('--set expects key=value (got "' + opts.set + '")');
          process.exit(1);
        }
        const key = opts.set.slice(0, eq);
        const value = opts.set.slice(eq + 1);
        runConfigSet(key, value);
        return;
      }
      await runConfigInteractive();
    });

  // Fallback: any other positional arg creates/opens a worktree with that name.
  // No arg = interactive picker (falls back to print list on non-TTY).
  program
    .argument('[feature-name]', 'Create a worktree and start Claude Code (or resume if exists)')
    .action(async (featureName: string | undefined) => {
      if (!featureName) {
        await runPicker();
        return;
      }
      const lower = featureName.toLowerCase();
      if (lower === 'help') {
        program.help();
        return;
      }
      if (lower === 'version') {
        console.log(pkg.version);
        return;
      }
      if (isReservedName(featureName)) {
        ui.error(`'${featureName}' is a reserved name and cannot be used as a feature name.`);
        ui.hint(`Reserved: ${RESERVED_NAMES.join(', ')}`);
        ui.hint("Run 'ccw --help' to see available commands.");
        process.exit(1);
      }
      await runCreate(featureName);
    });

  // Convert Commander's own errors (unknown options, bad flags, etc) into
  // our styled output without a raw stack trace.
  program.exitOverride((err: CommanderError) => {
    // Help / version exit cleanly with code 0 — let them through silently.
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version' || err.code === 'commander.help') {
      process.exit(0);
    }

    // For unknown-option errors, Commander has already printed the message
    // and help. Try to add a suggestion on top.
    if (err.code === 'commander.unknownOption') {
      const match = err.message.match(/unknown option '([^']+)'/);
      const flag = match?.[1];
      if (flag) {
        const suggestion = findClosestMatch(flag.replace(/^-+/, ''), KNOWN_COMMANDS);
        if (suggestion) {
          ui.hint(`Did you mean '${ui.bold(`--${suggestion}`)}' or '${ui.bold(suggestion)}'?`);
        }
      }
    }

    process.exit(err.exitCode || 1);
  });

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  if (err instanceof CommanderError) {
    // Already handled by exitOverride
    return;
  }
  if (err instanceof ConfigMissingError) {
    ui.error('This repository is not configured for ccw.');
    ui.hint(`Run ${ui.bold('ccw init')} to set it up.`);
    process.exit(1);
  }
  if (err instanceof Error) {
    ui.error(err.message);
  } else {
    ui.error(String(err));
  }
  process.exit(1);
});
