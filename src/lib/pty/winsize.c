/*
 * Header-free terminal window-size helpers, compiled at runtime by Bun's
 * bundled TinyCC (see ffi.ts).
 *
 * Why this exists: setting a PTY's window size requires
 * ioctl(fd, TIOCSWINSZ, &winsize), and ioctl is variadic
 * (`int ioctl(int, unsigned long, ...)`). On arm64-darwin the variadic ABI
 * passes the variadic argument on the stack, but Bun's FFI has no variadic
 * support and marshals it into a register — so a direct FFI ioctl writes the
 * winsize to a garbage address and segfaults on Apple Silicon. Compiling this
 * tiny C through TinyCC lets the *C* call site emit a correct variadic call,
 * while Bun's FFI only ever calls the non-variadic wrappers below.
 *
 * We deliberately avoid system headers (no #include) so TinyCC needs no SDK
 * present on the user's machine: we declare the struct, the constants, and the
 * ioctl prototype ourselves. `ioctl` resolves against the process's libc at
 * link time, which is always available.
 */
typedef unsigned short u16;

struct ccw_winsize {
  u16 ws_row;
  u16 ws_col;
  u16 ws_xpixel;
  u16 ws_ypixel;
};

extern int ioctl(int fd, unsigned long request, ...);

/* TIOCSWINSZ / TIOCGWINSZ are stable per-OS ioctl request numbers. */
#ifdef __APPLE__
#define CCW_TIOCSWINSZ 0x80087467UL
#define CCW_TIOCGWINSZ 0x40087468UL
#else
#define CCW_TIOCSWINSZ 0x5414UL
#define CCW_TIOCGWINSZ 0x5413UL
#endif

/* Returns 0 on success, -1 on error. */
int ccw_set_winsize(int fd, int rows, int cols) {
  struct ccw_winsize ws;
  ws.ws_row = (u16)rows;
  ws.ws_col = (u16)cols;
  ws.ws_xpixel = 0;
  ws.ws_ypixel = 0;
  return ioctl(fd, CCW_TIOCSWINSZ, &ws);
}

/* Readback helpers — used by the test suite to verify the set landed. */
int ccw_get_rows(int fd) {
  struct ccw_winsize ws;
  if (ioctl(fd, CCW_TIOCGWINSZ, &ws) != 0) return -1;
  return ws.ws_row;
}

int ccw_get_cols(int fd) {
  struct ccw_winsize ws;
  if (ioctl(fd, CCW_TIOCGWINSZ, &ws) != 0) return -1;
  return ws.ws_col;
}
