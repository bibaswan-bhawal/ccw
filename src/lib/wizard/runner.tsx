import React, { useEffect, useState } from "react";
import { render } from "ink";
import { altScreenSupported } from "../terminal.ts";
import { AbortModal, Wizard } from "./Wizard.tsx";
import {
  type AnswerMap,
  type InitStep,
  initialState,
  reduce,
  type WizardAction,
  type WizardState,
} from "./types.ts";

export interface RunWizardOptions {
  steps: InitStep[];
  /** Title shown in the header (e.g. repo path). */
  title: string;
  /** Optional subtitle (e.g. "Configure your repository"). */
  subtitle?: string;
}

export interface WizardResult {
  aborted: boolean;
  answers: AnswerMap;
}

/**
 * Mount the wizard, drive it to completion (or abort), and return the
 * collected answers.
 *
 * On terminals that handle the alt-screen buffer cleanly (iTerm2,
 * Terminal.app, Kitty, WezTerm, etc.), we render in alt-screen so the
 * scrollback is preserved on exit and resize redraws are clean. Other
 * terminals (notably Warp) get an inline render with the natural
 * scrollback flow — no full-screen takeover.
 */
export async function runWizard(options: RunWizardOptions): Promise<WizardResult> {
  let resolveOuter: (result: WizardResult) => void = () => {};
  const outer = new Promise<WizardResult>((r) => {
    resolveOuter = r;
  });

  const altScreen = altScreenSupported();
  const root = render(<WizardHost {...options} altScreen={altScreen} onComplete={(r) => resolveOuter(r)} />, {
    exitOnCtrlC: false,
    alternateScreen: altScreen,
  });

  const result = await outer;
  root.unmount();
  await root.waitUntilExit();
  return result;
}

interface HostProps extends RunWizardOptions {
  altScreen: boolean;
  onComplete: (result: WizardResult) => void;
}

function WizardHost({ steps, title, subtitle, altScreen, onComplete }: HostProps): React.ReactElement {
  const [state, setState] = useState<WizardState>(() => initialState(steps));
  const [showAbort, setShowAbort] = useState(false);

  const dispatch = (action: WizardAction): void => {
    setState((s) => reduce(s, action));
  };

  // Run a verify step whenever we land on one.
  useEffect(() => {
    if (state.done || state.aborted) return;
    const step = state.steps[state.cursor];
    if (!step || step.type !== "verify") return;

    let cancelled = false;
    (async () => {
      try {
        const result = await step.run(state.answers);
        if (cancelled) return;
        dispatch({ type: "verify_success", value: result });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        dispatch({ type: "verify_fail", message, rollbackTo: step.onFailGoTo });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.cursor, state.done, state.aborted]);

  // Resolve the outer promise once the wizard reaches a terminal state.
  useEffect(() => {
    if (state.done) {
      onComplete({ aborted: false, answers: state.answers });
    } else if (state.aborted) {
      onComplete({ aborted: true, answers: state.answers });
    }
  }, [state.done, state.aborted]);

  if (showAbort) {
    return (
      <AbortModal
        onConfirm={() => {
          setShowAbort(false);
          dispatch({ type: "abort" });
        }}
        onCancel={() => setShowAbort(false)}
      />
    );
  }

  return (
    <Wizard
      state={state}
      title={title}
      subtitle={subtitle}
      fullHeight={altScreen}
      onAnswer={(value) => dispatch({ type: "answer", value })}
      onBack={() => dispatch({ type: "back" })}
      onAbortRequest={() => setShowAbort(true)}
      abortModalOpen={showAbort}
    />
  );
}
