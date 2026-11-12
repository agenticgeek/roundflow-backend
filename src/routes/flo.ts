import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { enforceAdminOnlyRoutes } from "../middleware/requireAdmin";
import { AppError } from "../lib/app-error";
import { h } from "../lib/http";
import { createLimiter } from "../lib/rate-limit";
import { createFloService, type FloServiceDeps } from "../services/flo/flo.service";
import { floLimiterConfig } from "../services/flo/limits";
import { streamEvents } from "../services/flo/sse";

// Flo AI (plan 3.6). ADMIN only: the six routes are in ADMIN_ONLY_ROUTES (src/lib/permissions.ts) and enforced here.
// POST /flo/chat answers text/event-stream; every error before the first byte is a normal JSON HTTP error.
// Literal paths (/status, /suggestions, /conversations) come before the templated /conversations/:id.

export interface FloRouterOptions {
  env?: NodeJS.ProcessEnv;
  deps?: FloServiceDeps;
  heartbeatMs?: number;
}

const MAX_LIST_LIMIT = 100;
const MAX_CURSOR_CHARS = 64;

export function createFloRouter(opts: FloRouterOptions = {}): Router {
  const env = opts.env ?? process.env;
  const router = Router();
  const service = (req: Request) => createFloService(req.tenantPrisma!, { ...opts.deps, env });

  router.use(requireAuth, requireTenantAccess, requireBusinessAccess(), enforceAdminOnlyRoutes());

  // Per admin profile (not per IP: an office behind one NAT shares an address). Declined messages count too.
  const { windowMs, max } = floLimiterConfig(env);
  const chatLimiter = createLimiter({ windowMs, limit: max, disabled: env.RATE_LIMIT_DISABLED === "true", keyGenerator: (req) => req.profile!.id });

  // GET /flo/status -> { enabled, modes: [{ key, label, description }], dailyRemaining }
  router.get("/status", h(async (req, res) => res.json(await service(req).status())));

  // GET /flo/suggestions -> { groups: [{ area, questions }] }
  router.get("/suggestions", (req, res) => res.json(service(req).suggestions()));

  // POST /flo/chat { conversationId?, message, mode } -> text/event-stream (see swagger for the events)
  router.post(
    "/chat",
    chatLimiter,
    h(async (req, res) => {
      const handle = await service(req).prepare({
        profileId: req.profile!.id,
        body: req.body,
        idempotencyKey: req.header("idempotency-key") ?? req.header("x-idempotency-key"),
      });
      await streamEvents(res, (signal) => handle.events(signal), {
        heartbeatMs: opts.heartbeatMs,
        headers: handle.replayed ? { "Idempotent-Replay": "true" } : undefined,
      });
    })
  );

  // GET /flo/conversations?cursor=&limit= -> { conversations: [{ id, title, updatedAt }], nextCursor }
  router.get(
    "/conversations",
    h(async (req, res) => {
      const { cursor, limit } = req.query;
      if (cursor !== undefined && (typeof cursor !== "string" || cursor === "" || cursor.length > MAX_CURSOR_CHARS)) {
        throw new AppError(400, "cursor is not valid.", "INVALID_CURSOR");
      }
      const n = limit === undefined ? undefined : Number(limit);
      if (n !== undefined && (!Number.isInteger(n) || n < 1)) throw new AppError(400, "limit must be a positive whole number.", "INVALID_LIMIT");
      res.json(await service(req).listConversations(req.profile!.id, { cursor, limit: n === undefined ? undefined : Math.min(n, MAX_LIST_LIMIT) }));
    })
  );

  // GET /flo/conversations/:id -> { id, title, messages }; another admin's id is 404
  router.get("/conversations/:id", h(async (req, res) => res.json(await service(req).getConversation(req.profile!.id, req.params.id))));

  // DELETE /flo/conversations/:id -> 204
  router.delete(
    "/conversations/:id",
    h(async (req, res) => {
      await service(req).deleteConversation(req.profile!.id, req.params.id);
      res.status(204).end();
    })
  );

  return router;
}

export const floRouter = createFloRouter();
