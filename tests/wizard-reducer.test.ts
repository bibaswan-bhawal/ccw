import { describe, expect, test } from 'vitest';
import { initialState, reduce, visibleProgress, type InitStep } from '../src/lib/wizard/types.ts';

const textStep = (id: string, question = id): InitStep => ({ id, type: 'text', question });
const verifyStep = (id: string, opts: { onFailGoTo?: string } = {}): InitStep => ({
  id,
  type: 'verify',
  question: id,
  run: async () => undefined,
  onFailGoTo: opts.onFailGoTo,
});

describe('wizard reducer', () => {
  test('answer advances cursor and stores value', () => {
    const s0 = initialState([textStep('a'), textStep('b')]);
    const s1 = reduce(s0, { type: 'answer', value: 'first' });
    expect(s1.cursor).toBe(1);
    expect(s1.answers).toEqual({ a: 'first' });
    expect(s1.done).toBe(false);
  });

  test('answer on last step marks done', () => {
    const s0 = initialState([textStep('a')]);
    const s1 = reduce(s0, { type: 'answer', value: 'one' });
    expect(s1.done).toBe(true);
  });

  test('back decrements cursor', () => {
    let s = initialState([textStep('a'), textStep('b'), textStep('c')]);
    s = reduce(s, { type: 'answer', value: '1' });
    s = reduce(s, { type: 'answer', value: '2' });
    expect(s.cursor).toBe(2);
    s = reduce(s, { type: 'back' });
    expect(s.cursor).toBe(1);
  });

  test('back skips past hidden verify steps', () => {
    let s = initialState([textStep('a'), verifyStep('v'), textStep('b')]);
    // simulate landing on b after a successful verify
    s = reduce(s, { type: 'answer', value: 'first' });
    expect(s.cursor).toBe(1);
    s = reduce(s, { type: 'verify_success', value: 'ok' });
    expect(s.cursor).toBe(2);
    s = reduce(s, { type: 'back' });
    // should land on 'a', not on the verify step
    expect(s.steps[s.cursor]?.id).toBe('a');
  });

  test('verify_fail rolls back to onFailGoTo', () => {
    let s = initialState([textStep('a'), textStep('b'), verifyStep('v', { onFailGoTo: 'a' })]);
    s = reduce(s, { type: 'answer', value: 'one' });
    s = reduce(s, { type: 'answer', value: 'two' });
    expect(s.cursor).toBe(2);
    s = reduce(s, { type: 'verify_fail', message: 'bad', rollbackTo: 'a' });
    expect(s.cursor).toBe(0);
    expect(s.error).toBe('bad');
  });

  test('verify_fail without target rolls back one step', () => {
    let s = initialState([textStep('a'), verifyStep('v')]);
    s = reduce(s, { type: 'answer', value: 'one' });
    expect(s.cursor).toBe(1);
    s = reduce(s, { type: 'verify_fail', message: 'bad', rollbackTo: undefined });
    expect(s.cursor).toBe(0);
  });

  test('back at cursor 0 is a no-op', () => {
    const s0 = initialState([textStep('a')]);
    const s1 = reduce(s0, { type: 'back' });
    expect(s1.cursor).toBe(0);
  });

  test('abort sets aborted', () => {
    const s = reduce(initialState([textStep('a')]), { type: 'abort' });
    expect(s.aborted).toBe(true);
  });

  test('verifying flag is set when next step is a verify', () => {
    const s0 = initialState([textStep('a'), verifyStep('v')]);
    const s1 = reduce(s0, { type: 'answer', value: 'one' });
    expect(s1.verifying).toBe(true);
  });
});

describe('visibleProgress', () => {
  test('counts non-hidden / non-verify steps', () => {
    const steps: InitStep[] = [textStep('a'), verifyStep('v'), textStep('b'), textStep('c')];
    let s = initialState(steps);
    expect(visibleProgress(s)).toEqual({ current: 1, total: 3 });
    s = reduce(s, { type: 'answer', value: '1' });
    s = reduce(s, { type: 'verify_success', value: 'ok' });
    expect(s.steps[s.cursor]?.id).toBe('b');
    expect(visibleProgress(s)).toEqual({ current: 2, total: 3 });
  });
});
