import { Request, Router } from "express";
import { UserRole } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { requireTenantAccess } from "../middleware/requireTenantAccess";
import { requireRole } from "../middleware/requireRole";
import { h, optString } from "../lib/http";
import { createInvoiceService } from "../services/invoice.service";

export const invoicesRouter = Router();
invoicesRouter.use(requireAuth);
invoicesRouter.use(requireTenantAccess);
invoicesRouter.use(requireRole(UserRole.ADMIN, UserRole.MANAGER));

const svc = (req: Request) => createInvoiceService(req.tenantPrisma!);

// GET /invoices/preview?visitId=
invoicesRouter.get(
  "/preview",
  h(async (req, res) => {
    const visitId = req.query.visitId as string | undefined;
    if (!visitId) return res.status(400).json({ error: "visitId query param is required" });
    const preview = await svc(req).previewInvoice(visitId);
    return res.json(preview);
  })
);

// GET /invoices/:id
invoicesRouter.get(
  "/:id",
  h(async (req, res) => {
    const invoice = await svc(req).getInvoice(req.params.id);
    return res.json(invoice);
  })
);

// POST /invoices
invoicesRouter.post(
  "/",
  h(async (req, res) => {
    const { visitId, notes, dueDate, sendEmail } = req.body ?? {};
    if (!visitId || typeof visitId !== "string") {
      return res.status(400).json({ error: "visitId is required" });
    }
    const invoice = await svc(req).createInvoice({
      visitId,
      notes: optString(notes, "notes") ?? null,
      dueDate: optString(dueDate, "dueDate") ?? null,
      sendEmail: sendEmail === true,
    });
    return res.status(201).json(invoice);
  })
);

// POST /invoices/:id/send
invoicesRouter.post(
  "/:id/send",
  h(async (req, res) => {
    const result = await svc(req).sendInvoice(req.params.id);
    return res.json(result);
  })
);
