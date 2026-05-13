import pc from 'picocolors';

const isTTY = process.stdout.isTTY;

const symbols = isTTY
  ? { success: '✓', warn: '⚠', error: '✗', arrow: '→', bullet: '•' }
  : { success: '[ok]', warn: '[warn]', error: '[error]', arrow: '->', bullet: '*' };

export const ui = {
  // --- printing helpers (return void) ---
  success(message: string): void {
    console.log(`${pc.green(symbols.success)} ${message}`);
  },
  warn(message: string): void {
    console.warn(`${pc.yellow(symbols.warn)} ${pc.yellow(message)}`);
  },
  error(message: string): void {
    console.error(`${pc.red(symbols.error)} ${pc.red(message)}`);
  },
  info(message: string): void {
    console.log(`${pc.cyan(symbols.arrow)} ${message}`);
  },
  step(message: string): void {
    console.log(`${pc.dim(symbols.bullet)} ${message}`);
  },
  hint(message: string): void {
    console.log(pc.dim(message));
  },
  heading(message: string): void {
    console.log('');
    console.log(pc.bold(pc.cyan(message)));
    console.log(pc.dim('─'.repeat(Math.min(message.length, 80))));
  },
  blank(): void {
    console.log('');
  },

  // --- inline color helpers (return string) ---
  dim(text: string): string {
    return pc.dim(text);
  },
  bold(text: string): string {
    return pc.bold(text);
  },
  cyan(text: string): string {
    return pc.cyan(text);
  },
  green(text: string): string {
    return pc.green(text);
  },
  yellow(text: string): string {
    return pc.yellow(text);
  },
  red(text: string): string {
    return pc.red(text);
  },

  /**
   * OSC 8 hyperlink. Modern terminals (iTerm2, Kitty, WezTerm, Terminal.app,
   * Ghostty) render this as clickable. Terminals that don't understand it
   * show only the `text`.
   * Falls back to "text (url)" in non-TTY environments (pipes, CI).
   */
  link(text: string, url: string): string {
    if (!isTTY) return `${text} (${url})`;
    const OSC = ']';
    const ST = '\\';
    return `${OSC}8;;${url}${ST}${text}${OSC}8;;${ST}`;
  },
};
