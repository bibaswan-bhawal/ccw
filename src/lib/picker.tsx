import React, { useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import { altScreenSupported } from "./terminal.ts";
import { ui } from "./ui.ts";

/**
 * Build a consistent footer hint for picker / pickMany prompts.
 *
 * Renders as:
 *   <count> worktree(s) · <action-hint> · Esc to cancel
 *
 * Always prefixed with a leading newline so callers don't have to
 * remember to add the visual gap above it.
 */
export function pickerFooter(count: number, actionHint: string): string {
  const parts = [`${count} worktree(s)`, actionHint, "Esc to cancel"];
  return "\n" + ui.dim(parts.join(" · "));
}

export interface PickerItem<T> {
  value: T;
  /** Lines to render when this item is NOT highlighted. */
  lines: string[];
  /** Lines to render when this item IS highlighted. Defaults to `lines`. */
  selectedLines?: string[];
}

interface PickerCommonOptions<T> {
  items: PickerItem<T>[];
  /** Header rendered above the list (single line). */
  header?: string;
  footer?: string;
  initialIndex?: number;
  /**
   * Take over the terminal using the alternate screen buffer (like vim/less).
   * The previous terminal contents are restored on exit.
   */
  fullscreen?: boolean;
}

export type PickerOptions<T> = PickerCommonOptions<T>;

export interface MultiPickerOptions<T> extends PickerCommonOptions<T> {
  /** Initial set of values that are pre-selected. */
  initialSelected?: T[];
}

// Enter alternate screen, clear it, and home the cursor so the picker
// always starts at the top-left instead of wherever the cursor happened
// to be in the previous buffer.
const ALT_SCREEN_ENTER = "\x1b[?1049h\x1b[H\x1b[2J";
const ALT_SCREEN_LEAVE = "\x1b[?1049l";

/**
 * Single-select picker. Returns the selected value, or undefined if cancelled.
 * Built on Ink for robust terminal handling.
 */
export async function pick<T>(options: PickerOptions<T>): Promise<T | undefined> {
  const { items } = options;
  if (items.length === 0) return undefined;

  // Honor the caller's fullscreen request only when the terminal supports
  // alt-screen rendering. Warp and similar terminals fall back to inline.
  const useAltScreen = options.fullscreen && altScreenSupported();
  if (useAltScreen) process.stdout.write(ALT_SCREEN_ENTER);

  let result: T | undefined = undefined;
  const instance = render(
    <SinglePicker
      {...options}
      fullscreen={useAltScreen}
      onResolve={(value) => {
        result = value;
      }}
    />,
    { exitOnCtrlC: false },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    if (useAltScreen) process.stdout.write(ALT_SCREEN_LEAVE);
  }
  return result;
}

/**
 * Multi-select picker. Space toggles, Enter confirms.
 * Returns the selected values, or undefined if cancelled.
 */
export async function pickMany<T>(options: MultiPickerOptions<T>): Promise<T[] | undefined> {
  const { items } = options;
  if (items.length === 0) return [];

  const useAltScreen = options.fullscreen && altScreenSupported();
  if (useAltScreen) process.stdout.write(ALT_SCREEN_ENTER);

  let result: T[] | undefined = undefined;
  const instance = render(
    <MultiPicker
      {...options}
      fullscreen={useAltScreen}
      onResolve={(values) => {
        result = values;
      }}
    />,
    { exitOnCtrlC: false },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    if (useAltScreen) process.stdout.write(ALT_SCREEN_LEAVE);
  }
  return result;
}

// --- Single-select component ---

interface SinglePickerProps<T> extends PickerCommonOptions<T> {
  onResolve: (value: T | undefined) => void;
}

function SinglePicker<T>({
  items,
  header,
  footer,
  initialIndex = 0,
  onResolve,
}: SinglePickerProps<T>): React.ReactElement {
  const [index, setIndex] = useState(Math.max(0, Math.min(initialIndex, items.length - 1)));
  const { exit } = useApp();

  useInput((input, key) => {
    if ((key.ctrl && input === "c") || key.escape || input === "q") {
      onResolve(undefined);
      exit();
      return;
    }
    if (key.return) {
      onResolve(items[index]?.value);
      exit();
      return;
    }
    if (key.upArrow || input === "k") {
      setIndex((i) => (i - 1 + items.length) % items.length);
      return;
    }
    if (key.downArrow || input === "j") {
      setIndex((i) => (i + 1) % items.length);
      return;
    }
    if (/^[1-9]$/.test(input)) {
      const target = parseInt(input, 10) - 1;
      if (target < items.length) setIndex(target);
    }
  });

  return (
    <Box flexDirection="column">
      {header ? <HeaderBlock text={header} /> : null}
      {items.map((item, i) => (
        <ItemView key={i} item={item} highlighted={i === index} mode="single" />
      ))}
      {footer ? <Text>{footer}</Text> : null}
    </Box>
  );
}

// --- Multi-select component ---

interface MultiPickerProps<T> extends MultiPickerOptions<T> {
  onResolve: (values: T[] | undefined) => void;
}

function MultiPicker<T>({
  items,
  header,
  footer,
  initialIndex = 0,
  initialSelected = [],
  onResolve,
}: MultiPickerProps<T>): React.ReactElement {
  const [index, setIndex] = useState(Math.max(0, Math.min(initialIndex, items.length - 1)));
  const [selected, setSelected] = useState<Set<number>>(() => {
    const set = new Set<number>();
    items.forEach((item, i) => {
      if (initialSelected.includes(item.value)) set.add(i);
    });
    return set;
  });
  const { exit } = useApp();

  const toggle = (i: number): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  useInput((input, key) => {
    if ((key.ctrl && input === "c") || key.escape) {
      onResolve(undefined);
      exit();
      return;
    }
    if (key.return) {
      const values = Array.from(selected)
        .sort((a, b) => a - b)
        .map((i) => items[i]!.value);
      onResolve(values);
      exit();
      return;
    }
    if (input === " ") {
      toggle(index);
      return;
    }
    if (input === "a") {
      // Toggle all
      setSelected((prev) => {
        if (prev.size === items.length) return new Set();
        return new Set(items.map((_, i) => i));
      });
      return;
    }
    if (key.upArrow || input === "k") {
      setIndex((i) => (i - 1 + items.length) % items.length);
      return;
    }
    if (key.downArrow || input === "j") {
      setIndex((i) => (i + 1) % items.length);
    }
  });

  return (
    <Box flexDirection="column">
      {header ? <HeaderBlock text={header} /> : null}
      {items.map((item, i) => (
        <ItemView
          key={i}
          item={item}
          highlighted={i === index}
          checked={selected.has(i)}
          mode="multi"
        />
      ))}
      {footer ? <Text>{footer}</Text> : null}
    </Box>
  );
}

// --- Shared rendering ---

function HeaderBlock({ text }: { text: string }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        {text}
      </Text>
      <Text dimColor>{"─".repeat(Math.min(text.length, 80))}</Text>
    </Box>
  );
}

interface ItemViewProps<T> {
  item: PickerItem<T>;
  highlighted: boolean;
  mode: "single" | "multi";
  checked?: boolean;
}

function ItemView<T>({ item, highlighted, mode, checked }: ItemViewProps<T>): React.ReactElement {
  const lines = highlighted ? (item.selectedLines ?? item.lines) : item.lines;
  const cursor = highlighted ? <Text color="cyan">❯ </Text> : "  ";
  const checkbox =
    mode === "multi" ? (checked ? <Text color="green">[✓] </Text> : <Text dimColor>[ ] </Text>) : "";

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>
          {i === 0 ? cursor : "  "}
          {i === 0 ? checkbox : mode === "multi" ? "    " : ""}
          {line}
        </Text>
      ))}
    </Box>
  );
}
