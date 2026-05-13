import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import Spinner from "ink-spinner";
import {
  type AnswerMap,
  type InitStep,
  type MultiSelectStep,
  type SelectStep,
  type TextStep,
  type VerifyStep,
  type WizardState,
  visibleProgress,
} from "./types.ts";

export interface WizardProps {
  state: WizardState;
  /** Title shown in the persistent header (e.g. repo path). */
  title: string;
  /** Subtitle shown under the title (e.g. "ccw init"). */
  subtitle?: string;
  /** Submit the current step's answer. */
  onAnswer: (value: unknown) => void;
  /** Move back one step. */
  onBack: () => void;
  /** Trigger Esc → confirm-abort dialog (parent owns the modal). */
  onAbortRequest: () => void;
  /** True while an abort confirmation modal is open above us. */
  abortModalOpen?: boolean;
}

function BlinkingCursor(): React.ReactElement {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setVisible((v) => !v), 500);
    return () => clearInterval(id);
  }, []);
  return <Text color="cyan">{visible ? "▌" : " "}</Text>;
}

// --- Header / footer ---

function Header({ title, subtitle }: { title: string; subtitle?: string }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="cyan">
          ccw init
        </Text>
        <Text dimColor> · </Text>
        <Text>{title}</Text>
      </Box>
      {subtitle ? (
        <Box>
          <Text dimColor>{subtitle}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function StepIndicator({ state }: { state: WizardState }): React.ReactElement {
  const { current, total } = visibleProgress(state);
  const step = state.steps[state.cursor];
  const section = step?.section;
  return (
    <Box marginBottom={1}>
      <Text dimColor>
        Step {current} of {total}
      </Text>
      {section ? (
        <>
          <Text dimColor> · </Text>
          <Text color="cyan">{section}</Text>
        </>
      ) : null}
    </Box>
  );
}

function Footer({ canBack }: { canBack: boolean }): React.ReactElement {
  const parts = [
    canBack ? "← back" : "",
    "Enter to continue",
    "Esc to abort",
  ].filter(Boolean);
  return (
    <Box marginTop={1}>
      <Text dimColor>{parts.join(" · ")}</Text>
    </Box>
  );
}

// --- Step renderers ---

interface StepRendererProps {
  step: InitStep;
  state: WizardState;
  onAnswer: (value: unknown) => void;
}

function TextStepView({
  step,
  state,
  onAnswer,
}: { step: TextStep } & Omit<StepRendererProps, "step">): React.ReactElement {
  const initial = (state.answers[step.id] as string | undefined) ?? "";
  const [value, setValue] = useState(initial);

  useInput((input, key) => {
    if (key.return) {
      const final = value.trim() || step.default || "";
      if (step.required && !final) {
        // Surface a soft error inline; don't advance.
        setValue(value); // no-op; the parent will show error from state if we surfaced it
        return;
      }
      onAnswer(final);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.escape) {
      setValue((v) => v + input);
    }
  });

  const display = step.masked ? "•".repeat(value.length) : value;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">? </Text>
        <Text bold>{step.question}</Text>
      </Box>
      {step.hint ? (
        <Box marginLeft={2}>
          <Text dimColor italic>
            {step.hint}
          </Text>
        </Box>
      ) : null}
      {step.default ? (
        <Box marginLeft={2} marginTop={step.hint ? 1 : 0}>
          <Text color="cyan">default </Text>
          <Text>{step.default}</Text>
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

function SelectStepView({
  step,
  state,
  onAnswer,
}: { step: SelectStep } & Omit<StepRendererProps, "step">): React.ReactElement {
  const initialIdx = (() => {
    const stored = state.answers[step.id] as string | undefined;
    const seed = stored ?? step.default;
    const idx = step.options.findIndex((o) => o.value === seed);
    return idx >= 0 ? idx : 0;
  })();
  const [index, setIndex] = useState(initialIdx);

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setIndex((i) => (i - 1 + step.options.length) % step.options.length);
      return;
    }
    if (key.downArrow || input === "j") {
      setIndex((i) => (i + 1) % step.options.length);
      return;
    }
    if (key.return) {
      const picked = step.options[index];
      if (picked) onAnswer(picked.value);
      return;
    }
    if (/^[1-9]$/.test(input)) {
      const target = parseInt(input, 10) - 1;
      if (target < step.options.length) setIndex(target);
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">? </Text>
        <Text bold>{step.question}</Text>
      </Box>
      {step.hint ? (
        <Box marginLeft={2}>
          <Text dimColor italic>
            {step.hint}
          </Text>
        </Box>
      ) : null}
      <Box flexDirection="column" marginLeft={2} marginTop={step.hint ? 1 : 0}>
        {step.options.map((opt, i) => {
          const selected = i === index;
          return (
            <Box key={opt.value}>
              <Text color="cyan">{selected ? "❯ " : "  "}</Text>
              <Text bold={selected}>{opt.label}</Text>
              {opt.description ? (
                <>
                  <Text dimColor> · </Text>
                  <Text dimColor>{opt.description}</Text>
                </>
              ) : null}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function MultiSelectStepView({
  step,
  state,
  onAnswer,
}: { step: MultiSelectStep } & Omit<StepRendererProps, "step">): React.ReactElement {
  const initialChecked = (() => {
    const stored = state.answers[step.id] as string[] | undefined;
    if (stored) return new Set(stored);
    return new Set(step.initialSelected ?? []);
  })();
  const [index, setIndex] = useState(0);
  const [checked, setChecked] = useState<Set<string>>(initialChecked);

  const toggle = (value: string): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setIndex((i) => (i - 1 + step.options.length) % step.options.length);
      return;
    }
    if (key.downArrow || input === "j") {
      setIndex((i) => (i + 1) % step.options.length);
      return;
    }
    if (input === " ") {
      const opt = step.options[index];
      if (opt) toggle(opt.value);
      return;
    }
    if (input === "a") {
      setChecked((prev) =>
        prev.size === step.options.length ? new Set() : new Set(step.options.map((o) => o.value)),
      );
      return;
    }
    if (key.return) {
      onAnswer(Array.from(checked));
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">? </Text>
        <Text bold>{step.question}</Text>
      </Box>
      {step.hint ? (
        <Box marginLeft={2}>
          <Text dimColor italic>
            {step.hint}
          </Text>
        </Box>
      ) : null}
      <Box flexDirection="column" marginLeft={2} marginTop={step.hint ? 1 : 0}>
        {step.options.map((opt, i) => {
          const isChecked = checked.has(opt.value);
          const selected = i === index;
          return (
            <Box key={opt.value}>
              <Text color="cyan">{selected ? "❯ " : "  "}</Text>
              {isChecked ? <Text color="green">[✓] </Text> : <Text dimColor>[ ] </Text>}
              <Text bold={selected}>{opt.label}</Text>
              {opt.description ? (
                <>
                  <Text dimColor> · </Text>
                  <Text dimColor>{opt.description}</Text>
                </>
              ) : null}
            </Box>
          );
        })}
      </Box>
      <Box marginLeft={2} marginTop={1}>
        <Text dimColor>Space to toggle · a to toggle all</Text>
      </Box>
    </Box>
  );
}

function VerifyStepView({
  step,
}: { step: VerifyStep } & Omit<StepRendererProps, "step">): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text> {step.question}</Text>
      </Box>
      {step.hint ? (
        <Box marginLeft={2}>
          <Text dimColor italic>
            {step.hint}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

// --- Main wizard ---

/**
 * Subscribe to terminal resize events and re-render with the new
 * dimensions. We pin the wizard's root box to these so resize redraws
 * the entire frame (no stacked stale footers).
 */
function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => {
      setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

export function Wizard({
  state,
  title,
  subtitle,
  onAnswer,
  onBack,
  onAbortRequest,
  abortModalOpen,
}: WizardProps): React.ReactElement {
  // Catch global keys (back, abort) — but suspend while a child renderer
  // owns Enter or while the abort modal is open above us.
  useInput((input, key) => {
    if (abortModalOpen) return;
    if (key.escape || (key.ctrl && input === "c")) {
      onAbortRequest();
      return;
    }
    if (key.leftArrow && state.cursor > 0) {
      onBack();
    }
  });

  const { columns, rows } = useTerminalSize();
  const step = state.steps[state.cursor];
  const canBack = state.cursor > 0 && !state.verifying;

  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={2} paddingY={1}>
      <Header title={title} subtitle={subtitle} />
      <StepIndicator state={state} />
      {state.error ? (
        <Box marginBottom={1}>
          <Text color="red">✗ </Text>
          <Text color="red">{state.error}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" flexGrow={1}>
        {step?.type === "text" ? <TextStepView step={step} state={state} onAnswer={onAnswer} /> : null}
        {step?.type === "select" ? <SelectStepView step={step} state={state} onAnswer={onAnswer} /> : null}
        {step?.type === "multiselect" ? (
          <MultiSelectStepView step={step} state={state} onAnswer={onAnswer} />
        ) : null}
        {step?.type === "verify" ? <VerifyStepView step={step} state={state} onAnswer={onAnswer} /> : null}
      </Box>
      <Footer canBack={canBack} />
    </Box>
  );
}

// --- Abort confirmation modal ---

export interface AbortModalProps {
  onConfirm: () => void;
  onCancel: () => void;
}

export function AbortModal({ onConfirm, onCancel }: AbortModalProps): React.ReactElement {
  useInput((input, key) => {
    if (input === "y" || input === "Y") onConfirm();
    if (input === "n" || input === "N" || key.escape) onCancel();
    if (key.return) onCancel();
  });
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box>
        <Text color="yellow">⚠ </Text>
        <Text bold>Abort ccw init?</Text>
      </Box>
      <Box marginLeft={2} marginTop={1}>
        <Text dimColor italic>Your changes will not be saved.</Text>
      </Box>
      <Box marginLeft={2} marginTop={1}>
        <Text dimColor>[y/N]</Text>
        <Text> </Text>
        <BlinkingCursor />
      </Box>
    </Box>
  );
}

// Re-export for convenience
export type { AnswerMap };
