import { Request, Router } from "express";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireBusinessAccess } from "../middleware/requireRole";
import { h } from "../lib/http";
import { createNotificationService } from "../mobile/services/notification.service";

// Admin/manager notification feed (NOTIF-02). Same Notification table and
// service as the technician /mobile/notifications endpoints; every query is
// scoped to the caller's own profile id, so nobody can read or mark another
// user's rows.
export const notificationsRouter = Router();

notificationsRouter.use(requireAuth, requireTenantAccess, requireBusinessAccess());

const svc = (req: Request) => createNotificationService(req.tenantPrisma!);

// GET /notifications?cursor= -> { notifications, unreadCount, nextCursor }
notificationsRouter.get(
  "/",
  h(async (req, res) => {
    const cursor = (req.query.cursor as string | undefined) || undefined;
    const page = await svc(req).list(req.profile!.id, cursor);
    res.json({
      notifications: page.notifications.map(({ profileId: _owner, ...n }) => n),
      unreadCount: page.unreadCount,
      nextCursor: page.nextCursor,
    });
  })
);

// GET /notifications/unread-count -> { unreadCount } (cheap; the header bell polls it)
notificationsRouter.get(
  "/unread-count",
  h(async (req, res) => {
    res.json({ unreadCount: await svc(req).unreadCount(req.profile!.id) });
  })
);

// POST /notifications/read-all -> { ok: true }. Literal path: registered before /:id/read.
notificationsRouter.post(
  "/read-all",
  h(async (req, res) => {
    await svc(req).markAllRead(req.profile!.id);
    res.json({ ok: true });
  })
);

// POST /notifications/:id/read -> { ok: true }. An unknown or foreign id is a silent no-op.
notificationsRouter.post(
  "/:id/read",
  h(async (req, res) => {
    await svc(req).markRead(req.profile!.id, req.params.id);
    res.json({ ok: true });
  })
);
