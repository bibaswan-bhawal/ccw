import React from "react";
import { Box, render, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { ui } from "./ui.ts";

type Phase =
  | { state: "loading"; label: string }
  | { state: "done"; label: string }
  | { state: "error"; label: string };

interface SpinnerViewProps {
  phase: Phase;
}

function SpinnerView({ phase }: SpinnerViewProps): React.ReactElement {
  // Swallow keystrokes so they don't leak to the terminal as echo while the
  // task is running (e.g. user impatiently typing during a slow git op).
  useInput(() => {});

  if (phase.state === "loading") {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text> {phase.label}</Text>
      </Box>
    );
  }
  if (phase.state === "done") {
    return (
      <Box>
        <Text color="green">✓</Text>
        <Text> {phase.label}</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text color="red">✗</Text>
      <Text> {phase.label}</Text>
    </Box>
  );
}

/**
 * Show a spinner while `task` runs. Once it settles, the same Ink frame is
 * rerendered with a ✓/✗ indicator and the success/error label, then unmounted
 * — leaving exactly one line on screen.
 */
export async function withSpinner<T>(
  label: string,
  task: () => Promise<T>,
  options: { successMessage?: string | ((result: T) => string) } = {},
): Promise<T> {
  const useInk = process.stdout.isTTY && !process.env.CI;

  const successLabel = (result: T): string =>
    typeof options.successMessage === "function"
      ? options.successMessage(result)
      : (options.successMessage ?? label);

  if (!useInk) {
    ui.step(label);
    try {
      const result = await task();
      ui.success(successLabel(result));
      return result;
    } catch (err) {
      ui.error(label);
      throw err;
    }
  }

  const instance = render(<SpinnerView phase={{ state: "loading", label }} />);

  try {
    const result = await task();
    instance.rerender(<SpinnerView phase={{ state: "done", label: successLabel(result) }} />);
    await instance.waitUntilRenderFlush();
    instance.unmount();
    await instance.waitUntilExit();
    return result;
  } catch (err) {
    instance.rerender(<SpinnerView phase={{ state: "error", label }} />);
    await instance.waitUntilRenderFlush();
    instance.unmount();
    await instance.waitUntilExit();
    throw err;
  }
}
