/**
 * Terminal capability detection.
 *
 * Some terminals (notably Warp) don't render the alternate screen buffer
 * the way iTerm2 / Terminal.app / Kitty / WezTerm do. When ccw enters
 * alt-screen on those, the layout gets stranded in the upper portion of
 * the pane with empty space below. Detect known offenders and fall back
 * to inline rendering in that case.
 */

const ALT_SCREEN_BLOCKLIST = new Set([
  // Warp blocks blocks application output to a structured "block" UI.
  // It tolerates alt-screen escapes but doesn't restore the previous
  // contents on exit, and full-screen Ink layouts render badly.
  'WarpTerminal',
]);

export function termProgram(): string | undefined {
  return process.env.TERM_PROGRAM;
}

/**
 * True when ccw should use the alt-screen buffer for full-screen
 * commands (init wizard, picker). False on terminals that don't render
 * it properly — those fall back to inline rendering.
 */
export function altScreenSupported(): boolean {
  if (!process.stdout.isTTY) return false;
  const program = termProgram();
  if (program && ALT_SCREEN_BLOCKLIST.has(program)) return false;
  return true;
}
