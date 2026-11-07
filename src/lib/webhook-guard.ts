import { Request, Response } from "express";
import { isDatabaseUnavailable } from "./error-handler";

// BE-02: public webhook handlers are plain async functions mounted without the
// `h()` wrapper, so a thrown DB/decrypt error became an unhandled rejection
// (and, on newer Node, a process crash). Wrap them: log, answer 503 when the
// database is unreachable (the provider retries) or 500 otherwise, and never
// rethrow. Errors raised after the response is already sent are only logged.
export type WebhookHandler = (req: Request, res: Response) => Promise<void>;

export function guardWebhook(label: string, handler: WebhookHandler) {
  return (req: Request, res: Response): void => {
    handler(req, res).catch((err) => {
      console.error(`[${label}] handler failed:`, err);
      if (res.headersSent) return;
      if (isDatabaseUnavailable(err)) {
        res.set("Retry-After", "5");
        res.status(503).json({ error: "Service temporarily unavailable", code: "DATABASE_UNAVAILABLE" });
        return;
      }
      res.status(500).json({ error: "Internal Server Error" });
    });
  };
}
