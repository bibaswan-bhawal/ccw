import React, { useEffect, useState } from "react";
import { Box, render, Text, useInput } from "ink";

/**
 * A blinking block cursor (`▌`). Ink hides the terminal's native cursor
 * inside a raw-mode app, so prompts that accept input render their own
 * to give the user something to "type into."
 */
function BlinkingCursor(): React.ReactElement {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setVisible((v) => !v), 500);
    return () => clearInterval(id);
  }, []);
  return <Text color="cyan">{visible ? "▌" : " "}</Text>;
}

/**
 * Thrown when the user cancels a prompt (Esc / Ctrl+C) and the caller
 * passed `throwOnCancel: true`. Lets composite flows (like a plugin's
 * init wizard) bail out cleanly instead of accepting the default.
 */
export class PromptCancelledError extends Error {
  constructor() {
    super("Prompt cancelled");
    this.name = "PromptCancelledError";
  }
}

export interface PromptOptions {
  /**
   * When true, Esc / Ctrl+C rejects the returned promise with
   * PromptCancelledError instead of resolving with the default value.
   */
  throwOnCancel?: boolean;
  /**
   * Optional helper text shown below the question. Use it to explain what
   * the field is for, give an example, or link to docs. Multi-line strings
   * render across multiple lines.
   */
  hint?: string;
}

// --- Confirm ---

interface ConfirmState {
  answer: boolean | null;
}

interface ConfirmViewProps {
  question: string;
  defaultYes: boolean;
  hint?: string;
  state: ConfirmState;
  onPick: (value: boolean) => void;
  onCancel: () => void;
}

function ConfirmView({
  question,
  defaultYes,
  hint,
  state,
  onPick,
  onCancel,
}: ConfirmViewProps): React.ReactElement {
  useInput((input, key) => {
    if (state.answer !== null) return;
    if ((key.ctrl && input === "c") || key.escape) {
      onCancel();
      return;
    }
    if (input === "y" || input === "Y") {
      onPick(true);
      return;
    }
    if (input === "n" || input === "N") {
      onPick(false);
      return;
    }
    if (key.return) {
      onPick(defaultYes);
    }
  });

  const yn = defaultYes ? "[Y/n]" : "[y/N]";

  if (state.answer === null) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="cyan">? </Text>
          <Text bold>{question}</Text>
          <Text> </Text>
          <Text dimColor>{yn} </Text>
          <BlinkingCursor />
        </Box>
        {hint ? (
          <Box marginLeft={2}>
            <Text dimColor italic>
              {hint}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }
  return (
    <Box>
      <Text color="cyan">? </Text>
      <Text bold>{question}</Text>
      <Text> </Text>
      <Text color={state.answer ? "green" : "yellow"}>{state.answer ? "yes" : "no"}</Text>
    </Box>
  );
}


/**
 * Yes/No confirmation prompt rendered with Ink.
 * Y/y/Enter accepts, N/n/Esc/Ctrl+C rejects. Default is taken when Enter is
 * pressed without typing a letter.
 *
 * The answered state is rerendered explicitly and flushed to stdout before
 * unmount, so the user always sees their selection before we move on.
 */
export async function confirm(
  question: string,
  defaultYes = false,
  options: PromptOptions = {},
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const state: ConfirmState = { answer: null };
    let resolved = false;

    const settle = (value: boolean, cancelled: boolean): void => {
      if (resolved) return;
      resolved = true;
      state.answer = value;
      instance.rerender(
        <ConfirmView
          question={question}
          defaultYes={defaultYes}
          hint={options.hint}
          state={state}
          onPick={() => {}}
          onCancel={() => {}}
        />,
      );
      instance
        .waitUntilRenderFlush()
        .then(() => instance.unmount())
        .then(() => instance.waitUntilExit())
        .then(() => {
          if (cancelled && options.throwOnCancel) {
            reject(new PromptCancelledError());
          } else {
            resolve(value);
          }
        });
    };

    const instance = render(
      <ConfirmView
        question={question}
        defaultYes={defaultYes}
        hint={options.hint}
        state={state}
        onPick={(value) => settle(value, false)}
        onCancel={() => settle(false, true)}
      />,
      { exitOnCtrlC: false },
    );
  });
}

// --- Free-form prompt ---

interface PromptViewProps {
  question: string;
  defaultValue: string | undefined;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  masked?: boolean;
}

function PromptView({
  question,
  defaultValue,
  hint,
  value,
  onChange,
  onSubmit,
  onCancel,
  masked,
}: PromptViewProps): React.ReactElement {
  useInput((input, key) => {
    if ((key.ctrl && input === "c") || key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onSubmit();
      return;
    }
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      onChange(value + input);
    }
  });

  const display = masked ? "•".repeat(value.length) : value;

  // Stack everything vertically so long content wraps cleanly within its
  // own indented block instead of breaking the question line. The hint
  // (italic + dim) and default (cyan label, value in input color) get
  // distinct visual treatments so they don't blend.
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">? </Text>
        <Text bold>{question}</Text>
      </Box>
      {hint ? (
        <Box marginLeft={2}>
          <Text dimColor italic>
            {hint}
          </Text>
        </Box>
      ) : null}
      {defaultValue ? (
        <Box marginLeft={2} marginTop={hint ? 1 : 0}>
          <Text color="cyan">default </Text>
          <Text>{defaultValue}</Text>
        </Box>
      ) : null}
      <Box marginLeft={2}>
        <Text color="cyan">{"› "}</Text>
        <Text>{display}</Text>
        <BlinkingCursor />
      </Box>
    </Box>
  );
}

export interface FreeFormPromptOptions extends PromptOptions {
  /** When true, typed characters render as dots (for tokens / passwords). */
  masked?: boolean;
}

/**
 * Free-form line input rendered with Ink. By default Esc/Ctrl+C resolves
 * with the default value (or empty string). Pass `throwOnCancel: true` to
 * reject with PromptCancelledError instead.
 */
export async function prompt(
  question: string,
  defaultValue?: string,
  options: FreeFormPromptOptions = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let resolved = false;

    const setValue = (next: string): void => {
      value = next;
      instance.rerender(buildView());
    };

    const buildView = (): React.ReactElement => (
      <PromptView
        question={question}
        defaultValue={defaultValue}
        hint={options.hint}
        value={value}
        masked={options.masked}
        onChange={setValue}
        onSubmit={() => settle(value.trim() || defaultValue || "", false)}
        onCancel={() => settle(defaultValue ?? "", true)}
      />
    );

    const settle = (final: string, cancelled: boolean): void => {
      if (resolved) return;
      resolved = true;
      value = final;
      instance.rerender(buildView());
      instance
        .waitUntilRenderFlush()
        .then(() => instance.unmount())
        .then(() => instance.waitUntilExit())
        .then(() => {
          if (cancelled && options.throwOnCancel) {
            reject(new PromptCancelledError());
          } else {
            resolve(final);
          }
        });
    };

    const instance = render(buildView(), { exitOnCtrlC: false });
  });
}
