// BE-09: graceful shutdown. On SIGTERM/SIGINT: stop accepting connections, stop the cron schedules, wait for
// in-flight HTTP requests and cron runs, close the database pools, exit. A hard timeout forces exit 1 so a stuck
// request can never keep a container alive past the orchestrator's kill grace period.

export const SHUTDOWN_TIMEOUT_MS = 25_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProcessLike = { on: (event: string, listener: (...args: any[]) => void) => unknown };

export interface ShutdownDeps {
  server: { close: (cb: (err?: Error) => void) => unknown; closeIdleConnections?: () => void };
  stopJobs: () => void;
  waitForJobs: () => Promise<unknown>;
  disconnect: () => Promise<unknown>;
  exit: (code: number) => void;
  proc?: ProcessLike;
  timeoutMs?: number;
}

/** Installs the signal handlers; returns the shutdown function (also used directly by tests). */
export function installGracefulShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const { server, stopJobs, waitForJobs, disconnect, exit, proc = process, timeoutMs = SHUTDOWN_TIMEOUT_MS } = deps;
  let started = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (started) return;
    started = true;
    console.log(`[shutdown] ${signal} received: draining`);

    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(hard);
      exit(code);
    };
    const hard = setTimeout(() => {
      console.error(`[shutdown] drain exceeded ${timeoutMs}ms: forcing exit`);
      finish(1);
    }, timeoutMs);
    hard.unref();

    stopJobs();
    const closed = new Promise<Error | undefined>((resolve) => server.close((err) => resolve(err)));
    server.closeIdleConnections?.();
    const [closeErr] = await Promise.all([closed, waitForJobs()]);
    let code = closeErr ? 1 : 0;
    try {
      await disconnect();
    } catch (err) {
      console.error("[shutdown] disconnect failed:", err);
      code = 1;
    }
    finish(code);
  };

  proc.on("SIGTERM", () => void shutdown("SIGTERM"));
  proc.on("SIGINT", () => void shutdown("SIGINT"));
  return shutdown;
}
