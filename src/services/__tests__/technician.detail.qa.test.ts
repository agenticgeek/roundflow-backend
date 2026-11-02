import { it, expect, vi } from "vitest";
import { createTechnicianService } from "../technician.service";

it("getTechnicianDetail builds today's workload on the tenant-local day and 404s for an unknown technician", async () => {
  const prisma: any = {
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ timezone: "Europe/London" }) },
    technician: {
      findUnique: vi.fn().mockResolvedValue({
        id: "t1", name: "Sam", phone: null, role: null, email: null, notes: null, active: true, profileId: "p1", avatarUrl: null,
        serviceAreas: [], roundTechnicians: [{ round: { id: "r1", name: "Mon" } }],
      }),
    },
    visit: {
      findMany: vi.fn().mockResolvedValue([
        { status: "COMPLETED", roundId: "r1", round: { id: "r1", name: "Mon" } },
        { status: "SKIPPED", roundId: "r1", round: { id: "r1", name: "Mon" } },
        { status: "SCHEDULED", roundId: "r1", round: { id: "r1", name: "Mon" } },
        { status: "SCHEDULED", roundId: null, round: null },
      ]),
    },
  };
  const out = await createTechnicianService(prisma).getTechnicianDetail("t1");
  expect(out.roundNames).toEqual(["Mon"]);
  expect(out.todayWorkload).toEqual([{ roundId: "r1", roundName: "Mon", total: 3, completed: 1, skipped: 1, remaining: 1 }]);
  prisma.technician.findUnique.mockResolvedValue(null);
  await expect(createTechnicianService(prisma).getTechnicianDetail("x")).rejects.toMatchObject({ statusCode: 404 });
});
