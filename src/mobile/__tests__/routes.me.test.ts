import { it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// ---------------------------------------------------------------------------
// Covers the validation added to PATCH /mobile/me:
//   - PROFILE_NAME_MAX_LENGTH bound on `name`
//   - assertValidDateOfBirth (format / real-calendar-date / 1900..today range)
// ---------------------------------------------------------------------------

const profileFindUnique = vi.fn();
const profileUpdate = vi.fn().mockResolvedValue({});
const technicianFindUnique = vi.fn().mockResolvedValue({ avatarUrl: null, serviceAreas: [] });
const technicianUpdateMany = vi.fn().mockResolvedValue({});

vi.mock("../../lib/prisma", () => ({
  prisma: {
    profile: {
      findUnique: (...args: unknown[]) => profileFindUnique(...args),
      update: (...args: unknown[]) => profileUpdate(...args),
    },
  },
}));

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { supabaseUserId: "sb-user-1", email: "james@roundflow.com" };
    next();
  },
}));

vi.mock("../../middleware/requireTenantAccess", () => ({
  requireTenantAccess: (req: any, _res: any, next: any) => {
    req.profile = { id: "profile-1", tenantId: "tenant-1", name: "James Carter" };
    req.tenantPrisma = {
      technician: {
        findUnique: (...args: unknown[]) => technicianFindUnique(...args),
        updateMany: (...args: unknown[]) => technicianUpdateMany(...args),
      },
    };
    next();
  },
}));

import { mobileRouter } from "../routes";
import { AppError } from "../../lib/app-error";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/mobile", mobileRouter);
  app.use((err: unknown, _req: any, res: any, _next: any) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: "Internal error" });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  profileFindUnique.mockResolvedValue({ name: "James Carter", dateOfBirth: null });
  profileUpdate.mockResolvedValue({});
  technicianFindUnique.mockResolvedValue({ avatarUrl: null, serviceAreas: [] });
  technicianUpdateMany.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// name max length
// ---------------------------------------------------------------------------

it("PATCH /mobile/me rejects a name longer than 100 characters", async () => {
  const res = await request(makeApp()).patch("/mobile/me").send({ name: "a".repeat(101) });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/at most 100 characters/);
  expect(profileUpdate).not.toHaveBeenCalled();
});

it("PATCH /mobile/me accepts a name at exactly 100 characters", async () => {
  const res = await request(makeApp()).patch("/mobile/me").send({ name: "a".repeat(100) });

  expect(res.status).toBe(200);
  expect(profileUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ name: "a".repeat(100) }) })
  );
});

it("PATCH /mobile/me without a name leaves the length check untouched", async () => {
  const res = await request(makeApp()).patch("/mobile/me").send({ avatarUrl: "https://cdn.example.com/a.jpg" });

  expect(res.status).toBe(200);
  expect(profileUpdate).not.toHaveBeenCalled();
  expect(technicianUpdateMany).toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// dateOfBirth validation
// ---------------------------------------------------------------------------

it("PATCH /mobile/me rejects a dateOfBirth with the wrong format", async () => {
  const res = await request(makeApp()).patch("/mobile/me").send({ dateOfBirth: "2026-1-5" });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/YYYY-MM-DD format/);
  expect(profileUpdate).not.toHaveBeenCalled();
});

it("PATCH /mobile/me rejects a dateOfBirth that is not a real calendar date", async () => {
  const res = await request(makeApp()).patch("/mobile/me").send({ dateOfBirth: "2026-02-30" });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/valid calendar date/);
  expect(profileUpdate).not.toHaveBeenCalled();
});

it("PATCH /mobile/me rejects a dateOfBirth before 1900", async () => {
  const res = await request(makeApp()).patch("/mobile/me").send({ dateOfBirth: "1899-12-31" });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/between 1900-01-01 and today/);
  expect(profileUpdate).not.toHaveBeenCalled();
});

it("PATCH /mobile/me rejects a dateOfBirth in the future", async () => {
  const res = await request(makeApp()).patch("/mobile/me").send({ dateOfBirth: "2099-01-01" });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/between 1900-01-01 and today/);
  expect(profileUpdate).not.toHaveBeenCalled();
});

it("PATCH /mobile/me accepts a valid dateOfBirth", async () => {
  const res = await request(makeApp()).patch("/mobile/me").send({ dateOfBirth: "1990-05-15" });

  expect(res.status).toBe(200);
  expect(profileUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ dateOfBirth: "1990-05-15" }) })
  );
});

it("PATCH /mobile/me without a dateOfBirth skips the date validation", async () => {
  const res = await request(makeApp()).patch("/mobile/me").send({ name: "Valid Name" });

  expect(res.status).toBe(200);
  expect(profileUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ data: { name: "Valid Name" } })
  );
});
