/**
 * Wizard step model — drives the `ccw init` UI.
 *
 * Plugins (and ccw core itself) describe their setup as a flat list of
 * declarative steps. The wizard owns the screen, navigation, and answer
 * collection. Verify steps run async actions that can roll back to an
 * earlier step on failure.
 */

export type StepId = string;

export interface BaseStep {
  /** Stable identifier for this step. Answers are keyed by this. */
  id: StepId;
  /** The question or label rendered as the step's heading. */
  question: string;
  /** Optional dim italic helper text underneath. */
  hint?: string;
  /**
   * Section label shown in the step indicator (e.g. "Configure jira").
   * Steps that share a section render as "Step N of M · <section>".
   */
  section?: string;
  /** Optional flag: hide this step from the count (e.g. silent verify). */
  hidden?: boolean;
}

export interface TextStep extends BaseStep {
  type: 'text';
  /** Initial value (and the value used if the user accepts the default). */
  default?: string;
  /** When true, typed characters render as bullets. */
  masked?: boolean;
  /** When true, blank submission is rejected with a "required" notice. */
  required?: boolean;
  /**
   * Where to persist this answer. "config" (default) goes into the
   * returned answer map; "credentials" routes it to the credentials store
   * for the named plugin.
   */
  store?: 'config' | { type: 'credentials'; plugin: string; key: string };
}

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

export interface SelectStep extends BaseStep {
  type: 'select';
  options: SelectOption[];
  default?: string;
}

export interface MultiSelectStep extends BaseStep {
  type: 'multiselect';
  options: SelectOption[];
  /** Pre-checked option values. */
  initialSelected?: string[];
}

export interface VerifyStep extends BaseStep {
  type: 'verify';
  /**
   * Run an async check against the answers so far. Throw to fail.
   * Resolved value is captured under this step's id like a regular answer.
   */
  run: (answers: AnswerMap) => Promise<unknown>;
  /**
   * If `run` throws, the wizard rolls back to this step id (the user
   * re-enters whatever was wrong) and re-runs forward. Defaults to the
   * step immediately before this one.
   */
  onFailGoTo?: StepId;
}

export type InitStep = TextStep | SelectStep | MultiSelectStep | VerifyStep;

export type AnswerMap = Record<StepId, unknown>;

// --- Reducer state machine ---

export interface WizardState {
  steps: InitStep[];
  /** Index of the currently active step. */
  cursor: number;
  /** Captured answers keyed by step id. */
  answers: AnswerMap;
  /**
   * Soft error on the current step (e.g. "required field" or a verify
   * failure). Cleared on the next answer submission.
   */
  error?: string;
  /** True while a verify step is awaiting `run`. */
  verifying: boolean;
  /** Set to true when the wizard finishes (last step submitted). */
  done: boolean;
  /** Set to true when the user aborts. */
  aborted: boolean;
}

export type WizardAction =
  | { type: 'answer'; value: unknown }
  | { type: 'back' }
  | { type: 'verify_success'; value: unknown }
  | { type: 'verify_fail'; message: string; rollbackTo: StepId | undefined }
  | { type: 'abort' }
  | { type: 'clear_error' };

export function initialState(steps: InitStep[]): WizardState {
  return {
    steps,
    cursor: 0,
    answers: {},
    error: undefined,
    verifying: false,
    done: steps.length === 0,
    aborted: false,
  };
}

function indexOfStep(steps: InitStep[], id: StepId): number {
  return steps.findIndex((s) => s.id === id);
}

export function reduce(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'answer': {
      const current = state.steps[state.cursor];
      if (!current) return state;
      const answers = { ...state.answers, [current.id]: action.value };
      // If the next step is a verify, the runner will trigger it; mark the
      // state as verifying so the UI can show a spinner.
      const nextCursor = state.cursor + 1;
      const nextStep = state.steps[nextCursor];
      const verifying = nextStep?.type === 'verify';
      const done = nextCursor >= state.steps.length;
      return { ...state, answers, cursor: nextCursor, error: undefined, verifying, done };
    }
    case 'back': {
      if (state.cursor === 0) return state;
      // Skip backwards past hidden steps (e.g. verify) so the user lands
      // on a step they actually answered.
      let cursor = state.cursor - 1;
      while (cursor > 0 && state.steps[cursor]?.type === 'verify') cursor -= 1;
      return { ...state, cursor, error: undefined, verifying: false, done: false };
    }
    case 'verify_success': {
      const current = state.steps[state.cursor];
      if (!current) return state;
      const answers = { ...state.answers, [current.id]: action.value };
      const nextCursor = state.cursor + 1;
      const nextStep = state.steps[nextCursor];
      const verifying = nextStep?.type === 'verify';
      const done = nextCursor >= state.steps.length;
      return { ...state, answers, cursor: nextCursor, error: undefined, verifying, done };
    }
    case 'verify_fail': {
      const target = action.rollbackTo ? indexOfStep(state.steps, action.rollbackTo) : state.cursor - 1;
      if (target < 0) return { ...state, error: action.message, verifying: false };
      return {
        ...state,
        cursor: target,
        error: action.message,
        verifying: false,
        done: false,
      };
    }
    case 'abort':
      return { ...state, aborted: true };
    case 'clear_error':
      return { ...state, error: undefined };
  }
}

// --- Helpers ---

/** Visible steps for the progress indicator. */
export function visibleSteps(steps: InitStep[]): InitStep[] {
  return steps.filter((s) => !s.hidden && s.type !== 'verify');
}

/** 1-based progress: "Step 3 of 8" honoring hidden/verify steps. */
export function visibleProgress(state: WizardState): { current: number; total: number } {
  const visible = visibleSteps(state.steps);
  const currentStep = state.steps[state.cursor];
  if (!currentStep) {
    return { current: visible.length, total: visible.length };
  }
  const visibleIdx = visible.findIndex((s) => s.id === currentStep.id);
  return {
    current: visibleIdx >= 0 ? visibleIdx + 1 : visible.length,
    total: visible.length,
  };
}
