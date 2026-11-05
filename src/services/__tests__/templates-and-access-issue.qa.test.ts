import { it, expect, vi } from "vitest";
import { assertKnownPlaceholders, TEMPLATE_VARIABLES } from "../message-templates";
import { createSettingsService } from "../settings.service";
import { createJobTrackerService } from "../../mobile/services/job-tracker.service";

const bad = (fn: () => unknown) => expect(fn).toThrow(expect.objectContaining({ statusCode: 400, code: "UNKNOWN_PLACEHOLDER" }));

it("C5 assertKnownPlaceholders accepts every sender variable and rejects the rest", () => {
  expect(() => assertKnownPlaceholders(TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(" "), "Hi {{ firstName }}", null, undefined)).not.toThrow();
  expect(() => assertKnownPlaceholders("Hi [Customer Name], no placeholders")).not.toThrow();
  bad(() => assertKnownPlaceholders("Hi {{not_a_real_token}}"));
  bad(() => assertKnownPlaceholders("ok {{firstName}}", "Subject {{nope}}"));
  bad(() => assertKnownPlaceholders("empty {{ }}"));
});

function makeSettings() {
  const prisma: any = {
    messageTemplate: {
      create: vi.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: "t1", createdAt: new Date(), updatedAt: new Date(), ...data })),
      findUnique: vi.fn().mockResolvedValue({ id: "t1" }),
      update: vi.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: "t1", createdAt: new Date(), updatedAt: new Date(), ...data })),
      delete: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi.fn((fn: any) => fn(prisma)),
  };
  return { prisma, svc: createSettingsService(prisma, "t_x") };
}

it("C5 template create/update/replace reject unknown placeholders and never write; SMS create + delete work", async () => {
  const { prisma, svc } = makeSettings();
  await expect(svc.createMessageTemplate({ name: "x", channel: "SMS", body: "Hi {{not_a_real_token}}" } as never)).rejects.toMatchObject({ code: "UNKNOWN_PLACEHOLDER" });
  await expect(svc.updateMessageTemplate("t1", { body: "{{nope}}" } as never)).rejects.toMatchObject({ statusCode: 400 });
  await expect(svc.replaceTemplates([{ name: "x", channel: "SMS", body: "{{nope}}" } as never])).rejects.toMatchObject({ statusCode: 400 });
  expect(prisma.messageTemplate.create).not.toHaveBeenCalled();
  expect(prisma.messageTemplate.update).not.toHaveBeenCalled();
  expect(prisma.messageTemplate.deleteMany).not.toHaveBeenCalled();

  const created = await svc.createMessageTemplate({ name: "Reminder", channel: "SMS", body: "Hi {{firstName}}", subject: null } as never);
  expect(created).toMatchObject({ id: "t1", name: "Reminder", channel: "SMS" });
  await svc.updateMessageTemplate("t1", { body: "Bye {{firstName}}" } as never);
  await svc.deleteMessageTemplate("t1");
  expect(prisma.messageTemplate.delete).toHaveBeenCalledWith({ where: { id: "t1" } });
  prisma.messageTemplate.findUnique.mockResolvedValue(null);
  await expect(svc.deleteMessageTemplate("gone")).rejects.toMatchObject({ statusCode: 404 });
});

it("C3 an access issue links the property and writes a dated note with the technician's name", async () => {
  const prisma: any = {
    visit: { findUnique: vi.fn().mockResolvedValue({ id: "v1", propertyId: "p1" }) },
    issue: { create: vi.fn((a: unknown) => Promise.resolve({ id: "i1", a })) },
    propertyNote: { create: vi.fn((a: unknown) => Promise.resolve(a)) },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const out = await createJobTrackerService(prisma).reportAccessIssue("v1", "GATE_LOCKED", "Padlocked", [], { technicianName: "Sam Lee", profileId: "prof1" });
  expect(out).toEqual({ id: "i1" });
  expect(prisma.issue.create.mock.calls[0][0].data).toMatchObject({ visitId: "v1", propertyId: "p1", type: "GATE_LOCKED" });
  const note = prisma.propertyNote.create.mock.calls[0][0].data;
  expect(note).toMatchObject({ propertyId: "p1", type: "INTERNAL", authorProfileId: "prof1" });
  expect(note.body).toMatch(/^\d{4}-\d{2}-\d{2} - Access problem \(GATE_LOCKED\) reported by Sam Lee: Padlocked$/);

  await createJobTrackerService(prisma).reportAccessIssue("v1", "OTHER", "x");
  expect(prisma.propertyNote.create.mock.calls[1][0].data.body).toContain("reported by technician");
  expect(prisma.propertyNote.create.mock.calls[1][0].data.authorProfileId).toBeNull();
});
