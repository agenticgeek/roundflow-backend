import { it, expect, vi, beforeEach } from "vitest";

vi.mock("../visit-assignment", () => ({ restampFutureVisits: vi.fn() }));
const createNotification = vi.fn();
vi.mock("../../mobile/services/notification.service", () => ({
  createNotificationService: vi.fn(() => ({ create: createNotification })),
}));

import { createTechnicianAvailabilityService, OPEN_ENDED_TO } from "../technician-availability.service";
import { restampFutureVisits } from "../visit-assignment";
import { VisitStatus } from "../../generated/tenant-client";

const day = (s: string) => new Date(`${s}T00:00:00Z`);
const NOW = new Date("2026-10-30T10:00:00Z");

function makeTp() {
  const tx = {
    visit: { updateMany: vi.fn().mockResolvedValue({ count: 4 }) },
    technicianAvailability: { create: vi.fn().mockResolvedValue({}) },
  };
  return {
    tx,
    tp: {
      technician: { findUnique: vi.fn() },
      technicianAvailability: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        findUnique: vi.fn(),
        delete: vi.fn(),
      },
      roundTechnician: { findMany: vi.fn().mockResolvedValue([{ roundId: "r1" }, { roundId: "r2" }]) },
      $transaction: vi.fn((cb: any) => cb(tx)),
    } as any,
  };
}

const SAM = { id: "t1", name: "Sam", active: true, profileId: "prof1" };
const ALEX = { id: "t2", name: "Alex", active: true, profileId: "prof2" };

beforeEach(() => {
  vi.mocked(restampFutureVisits).mockReset().mockResolvedValue(2);
  createNotification.mockReset().mockResolvedValue({});
});

it("list 404s for an unknown technician and returns windows newest first", async () => {
  const { tp } = makeTp();
  tp.technician.findUnique.mockResolvedValueOnce(null);
  await expect(createTechnicianAvailabilityService(tp).list("x")).rejects.toMatchObject({ statusCode: 404 });

  tp.technician.findUnique.mockResolvedValueOnce(SAM);
  tp.technicianAvailability.findMany.mockResolvedValue([{ id: "a1" }]);
  expect(await createTechnicianAvailabilityService(tp).list("t1")).toEqual([{ id: "a1" }]);
  expect(tp.technicianAvailability.findMany).toHaveBeenCalledWith({ where: { technicianId: "t1" }, orderBy: { from: "desc" } });
});

it("create stores a date-only window and restamps every round of the technician", async () => {
  const { tp } = makeTp();
  tp.technician.findUnique.mockResolvedValue(SAM);
  tp.technicianAvailability.create.mockResolvedValue({ id: "a1" });

  const res = await createTechnicianAvailabilityService(tp).create(
    "t1",
    { from: new Date("2026-11-02T13:00:00Z"), to: new Date("2026-11-06T08:00:00Z"), reason: "Holiday" },
    NOW
  );

  expect(tp.technicianAvailability.create).toHaveBeenCalledWith({
    data: { technicianId: "t1", from: day("2026-11-02"), to: day("2026-11-06"), reason: "Holiday" },
  });
  expect(restampFutureVisits).toHaveBeenCalledWith(tp, "r1", NOW);
  expect(restampFutureVisits).toHaveBeenCalledWith(tp, "r2", NOW);
  expect(res).toEqual({ id: "a1", visitsRestamped: 4 });
});

it("create defaults reason to null", async () => {
  const { tp } = makeTp();
  tp.technician.findUnique.mockResolvedValue(SAM);
  tp.technicianAvailability.create.mockResolvedValue({ id: "a1" });
  await createTechnicianAvailabilityService(tp).create("t1", { from: day("2026-11-02"), to: day("2026-11-02") }, NOW);
  expect(tp.technicianAvailability.create.mock.calls[0][0].data.reason).toBeNull();
});

it("remove 404s when the window is missing or belongs to another technician, else deletes and restamps", async () => {
  const { tp } = makeTp();
  const svc = createTechnicianAvailabilityService(tp);
  tp.technicianAvailability.findUnique.mockResolvedValueOnce(null);
  await expect(svc.remove("t1", "a1", NOW)).rejects.toMatchObject({ statusCode: 404 });
  tp.technicianAvailability.findUnique.mockResolvedValueOnce({ id: "a1", technicianId: "t9" });
  await expect(svc.remove("t1", "a1", NOW)).rejects.toMatchObject({ statusCode: 404 });

  tp.technicianAvailability.findUnique.mockResolvedValueOnce({ id: "a1", technicianId: "t1" });
  await svc.remove("t1", "a1", NOW);
  expect(tp.technicianAvailability.delete).toHaveBeenCalledWith({ where: { id: "a1" } });
  expect(restampFutureVisits).toHaveBeenCalledTimes(2);
});

it("replace rejects replacing with self, unknown technicians and an inactive replacement", async () => {
  const { tp } = makeTp();
  const svc = createTechnicianAvailabilityService(tp);
  const base = { from: day("2026-11-02"), notify: false };
  await expect(svc.replace("t1", { ...base, replacementTechnicianId: "t1" })).rejects.toMatchObject({ statusCode: 400 });

  tp.technician.findUnique.mockResolvedValueOnce(null);
  await expect(svc.replace("t1", { ...base, replacementTechnicianId: "t2" })).rejects.toMatchObject({
    statusCode: 404,
    message: "Technician not found",
  });

  tp.technician.findUnique.mockResolvedValueOnce(SAM).mockResolvedValueOnce(null);
  await expect(svc.replace("t1", { ...base, replacementTechnicianId: "t2" })).rejects.toMatchObject({
    statusCode: 404,
    message: "Replacement technician not found",
  });

  tp.technician.findUnique.mockResolvedValueOnce(SAM).mockResolvedValueOnce({ ...ALEX, active: false });
  await expect(svc.replace("t1", { ...base, replacementTechnicianId: "t2" })).rejects.toMatchObject({ statusCode: 400 });
});

it("replace reassigns SCHEDULED visits in the window, records unavailability and notifies both", async () => {
  const { tp, tx } = makeTp();
  tp.technician.findUnique.mockResolvedValueOnce(SAM).mockResolvedValueOnce(ALEX);

  const res = await createTechnicianAvailabilityService(tp).replace("t1", {
    replacementTechnicianId: "t2",
    from: new Date("2026-11-02T10:00:00Z"),
    to: new Date("2026-11-06T10:00:00Z"),
    notify: true,
  });

  expect(res).toEqual({ visitsReassigned: 4 });
  expect(tx.visit.updateMany).toHaveBeenCalledWith({
    where: {
      technicianId: "t1",
      status: VisitStatus.SCHEDULED,
      date: { gte: day("2026-11-02"), lt: day("2026-11-07") },
    },
    data: { technicianId: "t2", technicianOverride: true },
  });
  expect(tx.technicianAvailability.create).toHaveBeenCalledWith({
    data: { technicianId: "t1", from: day("2026-11-02"), to: day("2026-11-06"), reason: "Replaced by Alex" },
  });
  expect(createNotification).toHaveBeenCalledWith("prof2", "SCHEDULE", "New jobs assigned", "4 visit(s) from Sam, 2026-11-02 to 2026-11-06.");
  expect(createNotification).toHaveBeenCalledWith(
    "prof1",
    "SCHEDULE",
    "Jobs reassigned",
    "Your visits 2026-11-02 to 2026-11-06 were reassigned to Alex."
  );
});

it("replace open-ended uses the far-future window end, tolerates missing names/profiles and notification failures", async () => {
  const { tp, tx } = makeTp();
  tp.technician.findUnique
    .mockResolvedValueOnce({ ...SAM, name: null })
    .mockResolvedValueOnce({ ...ALEX, name: null, profileId: "prof2" });
  createNotification.mockRejectedValue(new Error("push down"));
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const res = await createTechnicianAvailabilityService(tp).replace("t1", {
    replacementTechnicianId: "t2",
    from: day("2026-11-02"),
    to: null,
    notify: true,
  });

  expect(res.visitsReassigned).toBe(4);
  expect(tx.visit.updateMany.mock.calls[0][0].where.date).toEqual({ gte: day("2026-11-02") });
  expect(tx.technicianAvailability.create.mock.calls[0][0].data).toMatchObject({
    to: OPEN_ENDED_TO,
    reason: "Replaced by another technician",
  });
  // Sam has profileId prof1 → both attempted, both failed and were swallowed.
  expect(createNotification).toHaveBeenCalledWith("prof2", "SCHEDULE", "New jobs assigned", "4 visit(s) from a colleague, 2026-11-02 onwards.");
  expect(createNotification).toHaveBeenCalledWith("prof1", "SCHEDULE", "Jobs reassigned", "Your visits 2026-11-02 onwards were reassigned to another technician.");
  expect(errSpy).toHaveBeenCalled();
  errSpy.mockRestore();
});

it("replace skips notifications when notify is false or the technician has no app profile", async () => {
  const { tp } = makeTp();
  tp.technician.findUnique.mockResolvedValueOnce(SAM).mockResolvedValueOnce(ALEX);
  await createTechnicianAvailabilityService(tp).replace("t1", { replacementTechnicianId: "t2", from: day("2026-11-02"), notify: false });
  expect(createNotification).not.toHaveBeenCalled();

  tp.technician.findUnique
    .mockResolvedValueOnce({ ...SAM, profileId: null })
    .mockResolvedValueOnce({ ...ALEX, profileId: null });
  await createTechnicianAvailabilityService(tp).replace("t1", { replacementTechnicianId: "t2", from: day("2026-11-02"), notify: true });
  expect(createNotification).not.toHaveBeenCalled();
});
