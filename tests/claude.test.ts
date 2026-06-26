import { describe, expect, test, vi } from 'vitest';
import { relinquishStdin } from '../src/lib/claude.ts';

function fakeTty(isTTY: boolean) {
  return {
    isTTY,
    removeAllListeners: vi.fn(),
    setRawMode: vi.fn(),
    pause: vi.fn(),
  };
}

describe('relinquishStdin', () => {
  test('detaches listeners, leaves raw mode, and pauses a TTY stdin', () => {
    const stdin = fakeTty(true);
    relinquishStdin(stdin as unknown as NodeJS.ReadStream);

    expect(stdin.removeAllListeners).toHaveBeenCalledWith('readable');
    expect(stdin.removeAllListeners).toHaveBeenCalledWith('data');
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
    expect(stdin.pause).toHaveBeenCalledTimes(1);
  });

  test('is a no-op on a non-TTY stdin (piped/CI)', () => {
    const stdin = fakeTty(false);
    relinquishStdin(stdin as unknown as NodeJS.ReadStream);

    expect(stdin.removeAllListeners).not.toHaveBeenCalled();
    expect(stdin.setRawMode).not.toHaveBeenCalled();
    expect(stdin.pause).not.toHaveBeenCalled();
  });

  test('swallows errors from an uncooperative stream', () => {
    const stdin = {
      isTTY: true,
      removeAllListeners: vi.fn(),
      setRawMode: vi.fn(() => {
        throw new Error('setRawMode EINVAL');
      }),
      pause: vi.fn(),
    };
    expect(() => relinquishStdin(stdin as unknown as NodeJS.ReadStream)).not.toThrow();
  });
});
