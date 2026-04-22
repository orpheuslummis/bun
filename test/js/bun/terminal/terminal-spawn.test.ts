import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isWindows } from "harness";

// Cross-platform Bun.Terminal + Bun.spawn integration tests that don't rely
// on POSIX-only behaviour (termios echo, SIGWINCH, cat/echo binaries). The
// remaining POSIX-specific coverage lives in terminal.test.ts.
describe("Bun.Terminal subprocess integration", () => {
  test("constructor creates a PTY", async () => {
    await using terminal = new Bun.Terminal({});
    expect(terminal.closed).toBe(false);
  });

  test("constructor with custom size", async () => {
    await using terminal = new Bun.Terminal({ cols: 120, rows: 40 });
    expect(terminal.closed).toBe(false);
  });

  test("write returns byte count", async () => {
    await using terminal = new Bun.Terminal({});
    expect(terminal.write("hello")).toBe(5);
    expect(terminal.write("")).toBe(0);
    expect(terminal.write(new TextEncoder().encode("abc"))).toBe(3);
  });

  test("resize succeeds", async () => {
    await using terminal = new Bun.Terminal({ cols: 80, rows: 24 });
    expect(() => terminal.resize(100, 30)).not.toThrow();
    expect(() => terminal.resize(40, 10)).not.toThrow();
  });

  test("close marks terminal closed and write throws", () => {
    const terminal = new Bun.Terminal({});
    terminal.close();
    expect(terminal.closed).toBe(true);
    expect(() => terminal.write("x")).toThrow();
    expect(() => terminal.resize(10, 10)).toThrow();
  });

  test.skipIf(!isWindows)("termios flag accessors return 0 on Windows", async () => {
    await using terminal = new Bun.Terminal({});
    expect(terminal.inputFlags).toBe(0);
    expect(terminal.outputFlags).toBe(0);
    expect(terminal.localFlags).toBe(0);
    expect(terminal.controlFlags).toBe(0);
  });

  test("data callback receives output from spawned process", async () => {
    let output = "";
    let callbackTerminal: Bun.Terminal | undefined;
    const { promise, resolve } = Promise.withResolvers<void>();

    const terminal = new Bun.Terminal({
      cols: 80,
      rows: 24,
      data(term, chunk: Uint8Array) {
        callbackTerminal = term;
        output += new TextDecoder().decode(chunk);
        if (output.includes("hello-from-conpty")) resolve();
      },
    });

    const proc = Bun.spawn({
      cmd: [bunExe(), "-e", "console.log('hello-from-conpty')"],
      env: bunEnv,
      terminal,
    });

    await promise;
    await proc.exited;
    terminal.close();

    expect(callbackTerminal).toBe(terminal);
    expect(output).toContain("hello-from-conpty");
  });

  test("subprocess sees a TTY on stdout", async () => {
    let output = "";
    const { promise, resolve } = Promise.withResolvers<void>();

    const terminal = new Bun.Terminal({
      cols: 80,
      rows: 24,
      data(_term, chunk: Uint8Array) {
        output += new TextDecoder().decode(chunk);
        if (output.includes("isTTY=")) resolve();
      },
    });

    const proc = Bun.spawn({
      cmd: [bunExe(), "-e", "process.stdout.write('isTTY=' + process.stdout.isTTY)"],
      env: bunEnv,
      terminal,
    });

    await promise;
    await proc.exited;
    terminal.close();

    expect(output).toContain("isTTY=true");
  });

  test("Bun.spawn with inline terminal option", async () => {
    let output = "";
    const { promise, resolve } = Promise.withResolvers<void>();

    const proc = Bun.spawn({
      cmd: [bunExe(), "-e", "console.log('inline-terminal')"],
      env: bunEnv,
      terminal: {
        cols: 80,
        rows: 24,
        data(_term, chunk: Uint8Array) {
          output += new TextDecoder().decode(chunk);
          if (output.includes("inline-terminal")) resolve();
        },
      },
    });

    expect(proc.terminal).toBeDefined();
    expect(proc.stdin).toBeNull();
    expect(proc.stdout).toBeNull();
    expect(proc.stderr).toBeNull();

    await promise;
    await proc.exited;
    proc.terminal?.close();

    expect(output).toContain("inline-terminal");
  });

  test("terminal.write reaches subprocess stdin", async () => {
    let output = "";
    const { promise, resolve } = Promise.withResolvers<void>();

    const terminal = new Bun.Terminal({
      cols: 80,
      rows: 24,
      data(_term, chunk: Uint8Array) {
        output += new TextDecoder().decode(chunk);
        if (output.includes("ECHO:abc")) resolve();
      },
    });

    const proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `process.stdin.setEncoding('utf8');
         process.stdin.on('data', d => { process.stdout.write('ECHO:' + d); process.exit(0); });`,
      ],
      env: bunEnv,
      terminal,
    });

    terminal.write("abc\r");
    await promise;
    await proc.exited;
    terminal.close();

    expect(output).toContain("ECHO:abc");
  });

  test("subprocess sees correct terminal dimensions", async () => {
    let output = "";
    const { promise, resolve } = Promise.withResolvers<void>();

    const terminal = new Bun.Terminal({
      cols: 123,
      rows: 45,
      data(_term, chunk: Uint8Array) {
        output += new TextDecoder().decode(chunk);
        if (output.includes("cols=")) resolve();
      },
    });

    const proc = Bun.spawn({
      cmd: [bunExe(), "-e", "process.stdout.write('cols=' + process.stdout.columns + ' rows=' + process.stdout.rows)"],
      env: bunEnv,
      terminal,
    });

    await promise;
    await proc.exited;
    terminal.close();

    expect(output).toContain("cols=123");
    expect(output).toContain("rows=45");
  });

  test("exit callback fires after close", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const terminal = new Bun.Terminal({
      exit() {
        resolve();
      },
    });
    terminal.close();
    await promise;
  });

  test("can create and close many terminals", () => {
    for (let i = 0; i < 20; i++) {
      const t = new Bun.Terminal({ cols: 80, rows: 24 });
      t.close();
      expect(t.closed).toBe(true);
    }
  });

  // termios c_lflag bit layout is platform-specific. These match sys/termios.h:
  // Linux uses the "System V" layout; Darwin/BSD share the "4.3BSD" layout.
  const ICANON = process.platform === "darwin" ? 0x100 : 0x2;
  const ECHO = 0x8; // same on both

  // Regression: a Bun child that never calls setRawMode must not write the
  // startup termios snapshot back to the terminal device at exit. Termios is
  // a property of the /dev/pts/* device, not the fd, so restoring here
  // clobbers any raw-mode state set on the same device by a downstream
  // pipeline consumer (less, fzf, fx, ...). See #29592.
  test.skipIf(isWindows)("child exit does not clobber raw mode on shared tty device", async () => {
    const ready = Promise.withResolvers<void>();
    // Buffer across chunks so a READY split between two PTY reads still matches.
    const decoder = new TextDecoder();
    let buffer = "";
    let sawReady = false;
    await using terminal = new Bun.Terminal({
      data(_, chunk: Uint8Array) {
        if (sawReady) return;
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.includes("READY")) {
          sawReady = true;
          ready.resolve();
        }
      },
    });

    // Child blocks on stdin until the parent signals it to exit. This makes
    // the ordering deterministic: the child cannot exit — and therefore
    // cannot run bun_restore_stdio — until after the parent has flipped
    // termios on the shared device. A timer-based race would silently
    // degrade into a vacuous pass on a slow runner.
    const proc = Bun.spawn({
      cmd: [bunExe(), "-e", `process.stdout.write("READY\\n"); process.stdin.once("data", () => process.exit(0));`],
      env: bunEnv,
      terminal,
    });

    await ready.promise;

    // Simulate a downstream consumer (less, fzf, ...) flipping the shared
    // device to raw mode, then let the child exit. Assert the PTY actually
    // started cooked so the test can't pass vacuously if Bun.Terminal's
    // defaults ever change.
    expect(terminal.localFlags & ICANON).not.toBe(0);
    expect(terminal.localFlags & ECHO).not.toBe(0);
    terminal.localFlags = terminal.localFlags & ~(ICANON | ECHO);
    expect(terminal.localFlags & ICANON).toBe(0);
    expect(terminal.localFlags & ECHO).toBe(0);

    terminal.write("\n");
    const exitCode = await proc.exited;

    // Termios assertions before exit code: these are the regression we care
    // about, and surfacing them first in the diff makes failures read right.
    expect(terminal.localFlags & ICANON).toBe(0);
    expect(terminal.localFlags & ECHO).toBe(0);
    expect(exitCode).toBe(0);
  });

  // Companion to the regression test above: setRawMode still has its own
  // restore path via uv_tty_reset_mode's atexit hook. A child that actually
  // modifies termios must leave the device in its pre-setRawMode state.
  //
  // Handshake with the child across its entire lifetime so the assertions
  // distinguish the three cases we care about:
  //   1. child wrote raw → assert cooked before, raw while live, cooked after
  //   2. setRawMode became a no-op → "raw while live" assertion fails
  //   3. our bookkeeping skipped the restore → "cooked after" assertion fails
  test.skipIf(isWindows)("child that called setRawMode restores termios on exit", async () => {
    const raw = Promise.withResolvers<void>();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawRaw = false;
    await using terminal = new Bun.Terminal({
      data(_, chunk: Uint8Array) {
        if (sawRaw) return;
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.includes("RAW")) {
          sawRaw = true;
          raw.resolve();
        }
      },
    });

    expect(terminal.localFlags & ICANON).not.toBe(0);
    expect(terminal.localFlags & ECHO).not.toBe(0);

    // Child enters raw mode, announces it, then blocks on stdin so the
    // parent can observe termios state while the child is still alive.
    const proc = Bun.spawn({
      cmd: [
        bunExe(),
        "-e",
        `process.stdin.setRawMode(true); process.stdout.write("RAW\\n"); process.stdin.once("data", () => process.exit(0));`,
      ],
      env: bunEnv,
      terminal,
    });

    await raw.promise;
    expect(terminal.localFlags & ICANON).toBe(0);
    expect(terminal.localFlags & ECHO).toBe(0);

    terminal.write("\n");
    const exitCode = await proc.exited;
    expect(terminal.localFlags & ICANON).not.toBe(0);
    expect(terminal.localFlags & ECHO).not.toBe(0);
    expect(exitCode).toBe(0);
  });
});
