import { it, expect, vi } from "vitest";
import { UserRole } from "@prisma/client";
import { Prisma as TenantPrisma } from "../../generated/tenant-client";
import request from "supertest";
import express from "express";
import {
  assertKnownPlaceholders,
  canonicalPlaceholder,
  normalizePlaceholders,
  renderTemplate,
  PLACEHOLDER_ALIASES,
} from "../message-templates";
import { renderReminder } from "../../jobs/preCleanReminders";
import { createSettingsService } from "../settings.service";
import { createCustomerService } from "../customer.service";
import { errorHandler, isDatabaseUnavailable } from "../../lib/error-handler";
import { findAliasTokens, listSnakeCaseTemplates, listSnakeCaseTemplatesForTenant } from "../../jobs/snakeCaseTemplatesReport";
import { createJobDetailService } from "../../mobile/services/job-detail.service";
import { createMediaService } from "../../mobile/services/media.service";

vi.mock("../../integrations/geocoding/client", () => ({ geocodePostcode: vi.fn().mockResolvedValue(null) }));
const tenantFindMany = vi.fn();
vi.mock("../../lib/prisma", () => ({ prisma: { tenant: { findMany: (...a: unknown[]) => tenantFindMany(...a) } } }));
const getTenantPrismaForSchema = vi.fn();
vi.mock("../../lib/tenant-prisma-manager", () => ({ getTenantPrismaForSchema: (...a: unknown[]) => getTenantPrismaForSchema(...a) }));

// ---- 1. placeholders --------------------------------------------------------

it("snake_case aliases are accepted, normalised to camelCase, and unknown tokens still rejected", () => {
  expect(() => assertKnownPlaceholders("Hi {{customer_name}} on {{ visit_date }} from {{business_name}}")).not.toThrow();
  expect(normalizePlaceholders("Hi {{customer_name}} on {{ visit_date }} {{firstName}} {{nope_token}} [Customer Name]")).toBe(
    "Hi {{customerName}} on {{date}} {{firstName}} {{nope_token}} [Customer Name]"
  );
  expect(normalizePlaceholders(null)).toBeNull();
  expect(normalizePlaceholders(undefined)).toBeUndefined();
  expect(normalizePlaceholders("")).toBe("");
  expect(() => assertKnownPlaceholders("{{customer_name}} {{not_real}}")).toThrow(expect.objectContaining({ code: "UNKNOWN_PLACEHOLDER", message: expect.stringContaining("{{not_real}}") }));
  expect(canonicalPlaceholder("due_date")).toBe("dueDate");
  expect(canonicalPlaceholder("whatever")).toBe("whatever");
  for (const canonical of Object.values(PLACEHOLDER_ALIASES)) expect(() => assertKnownPlaceholders(`{{${canonical}}}`)).not.toThrow();
});

it("rendering tolerates legacy snake_case tokens (templates and pre-clean reminders)", () => {
  expect(renderTemplate("Hi {{customer_name}}, {{ visit_date }} {{firstName}} {{unknown_x}}!", { customerName: "Jo Bloggs", firstName: "Jo", date: "2026-11-03" })).toBe("Hi Jo Bloggs, 2026-11-03 Jo !");
  const vars = { customerName: "Jo", date: "Tue", address: "1 High St", businessName: "Coates" };
  expect(renderReminder("{{customer_name}} {{visit_date}} {{business_name}} {{zzz}}", vars)).toBe("Jo Tue Coates ");
});

it("settings service saves normalised templates (create, update, replace)", async () => {
  const prisma: any = {
    messageTemplate: {
      create: vi.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: "t1", createdAt: new Date(), updatedAt: new Date(), ...data })),
      findUnique: vi.fn().mockResolvedValue({ id: "t1" }),
      update: vi.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: "t1", createdAt: new Date(), updatedAt: new Date(), ...data })),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi.fn((fn: any) => fn(prisma)),
  };
  const svc = createSettingsService(prisma, "t_x");
  const created = await svc.createMessageTemplate({ name: "n", channel: "SMS", body: "Hi {{customer_name}}", subject: "{{business_name}}" } as never);
  expect(created).toMatchObject({ body: "Hi {{customerName}}", subject: "{{businessName}}" });
  await svc.updateMessageTemplate("t1", { body: "{{visit_date}}" } as never);
  expect(prisma.messageTemplate.update.mock.calls[0][0].data).toMatchObject({ body: "{{date}}", subject: undefined });
  await svc.replaceTemplates([{ name: "n", channel: "SMS", body: "{{first_name}}" } as never]);
  expect(prisma.messageTemplate.createMany.mock.calls[0][0].data[0]).toMatchObject({ body: "{{firstName}}", subject: null });
});

// ---- 9. snake-case report -----------------------------------------------------

it("snake-case report lists only templates holding alias tokens, read-only", async () => {
  expect(findAliasTokens("{{customer_name}} {{ customer_name }} {{customerName}}", "{{due_date}}", null)).toEqual(["customer_name", "due_date"]);
  const tp: any = {
    messageTemplate: {
      findMany: vi.fn().mockResolvedValue([
        { id: "a", name: "Old", channel: "SMS", subject: null, body: "Hi {{customer_name}}" },
        { id: "b", name: "New", channel: "EMAIL", subject: "S", body: "Hi {{customerName}}" },
      ]),
    },
  };
  expect(await listSnakeCaseTemplatesForTenant(tp)).toEqual([{ templateId: "a", name: "Old", channel: "SMS", tokens: ["customer_name"] }]);
  tenantFindMany.mockResolvedValue([{ schemaName: "t_a" }]);
  getTenantPrismaForSchema.mockReturnValue(tp);
  expect(await listSnakeCaseTemplates()).toEqual([{ schemaName: "t_a", result: [{ templateId: "a", name: "Old", channel: "SMS", tokens: ["customer_name"] }] }]);
});

// ---- 7. database outage -> 503 -----------------------------------------------------

function appThrowing(err: unknown) {
  const app = express();
  app.get("/x", (_req, _res, next) => next(err));
  app.use(errorHandler);
  return app;
}

it("database connectivity errors answer 503 DATABASE_UNAVAILABLE with Retry-After; others stay 500", async () => {
  const init = new TenantPrisma.PrismaClientInitializationError("Can't reach database server at 127.0.0.1:54329", "6.19.3", "P1001");
  const known = (code: string) => new TenantPrisma.PrismaClientKnownRequestError("boom", { code, clientVersion: "6.19.3" });
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  for (const err of [init, known("P1001"), known("P1002"), known("P1017"), known("P2024")]) {
    const res = await request(appThrowing(err)).get("/x");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "The service is temporarily unavailable. Please try again in a moment.", code: "DATABASE_UNAVAILABLE" });
    expect(res.headers["retry-after"]).toBe("5");
  }
  expect((await request(appThrowing(known("P2002"))).get("/x")).status).toBe(500);
  expect((await request(appThrowing(new Error("x"))).get("/x")).status).toBe(500);
  expect(isDatabaseUnavailable(null)).toBe(false);
  expect(isDatabaseUnavailable("P1001")).toBe(false);
  expect(isDatabaseUnavailable({ name: "PrismaClientKnownRequestError", errorCode: "P1001" })).toBe(true);
  expect(isDatabaseUnavailable({ name: "SomethingElse", code: "P1001" })).toBe(false);
  expect(isDatabaseUnavailable({ name: "PrismaClientKnownRequestError" })).toBe(false);
  quiet.mockRestore();
});

// ---- 5/6. mobile job detail -----------------------------------------------------------

function detailPrisma(notes: any[], techProfiles: string[]) {
  return {
    businessSettings: { findFirst: vi.fn().mockResolvedValue(null) },
    technician: { findMany: vi.fn().mockResolvedValue(techProfiles.map((profileId) => ({ profileId }))) },
    customer: { findUnique: vi.fn().mockResolvedValue({ holdNextClean: false }) },
    visit: {
      findUnique: vi.fn().mockResolvedValue({
        id: "v2", roundId: "r1", technicianId: "t1", propertyId: "p1", date: new Date("2026-11-04T00:00:00Z"), price: { toNumber: () => 20 },
        paymentMethod: null, servicePlan: null,
        property: { id: "p1", customer: { id: "c1", name: "A", badDebt: false, paymentMethod: null, invoices: [] }, notes },
      }),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([{ id: "v1" }, { id: "v2" }, { id: "v3" }]),
    },
  } as any;
}

it("round position uses the technician's visits on the visit's own day, ordered createdAt then id", async () => {
  const p = detailPrisma([], []);
  const out = await createJobDetailService(p).getVisitDetail("v2");
  expect(out.roundPosition).toEqual({ position: 2, total: 3 });
  expect(p.visit.findMany.mock.calls[0][0]).toMatchObject({
    where: { roundId: "r1", technicianId: "t1", date: new Date("2026-11-04T00:00:00Z"), status: { not: "CANCELLED" } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
});

it("property notes carry source and mine so the technician's own note is not an access note", async () => {
  const at = new Date("2026-11-03T09:00:00Z");
  const notes = [
    { id: "n1", type: "RISK_WARNING", body: "Dog", createdAt: at, authorProfileId: "office1" },
    { id: "n2", type: "INTERNAL", body: "Back gate sticks", createdAt: at, authorProfileId: "prof-tech" },
    { id: "n3", type: "INTERNAL", body: "Other tech", createdAt: at, authorProfileId: "prof-other" },
    { id: "n4", type: "INTERNAL", body: "Legacy", createdAt: at, authorProfileId: null },
  ];
  const p = detailPrisma(notes, ["prof-tech", "prof-other"]);
  const out = await createJobDetailService(p).getVisitDetail("v2", "prof-tech");
  expect(out.property.notes.map((n) => [n.id, n.source, n.mine])).toEqual([
    ["n1", "OFFICE", false],
    ["n2", "TECHNICIAN", true],
    ["n3", "TECHNICIAN", false],
    ["n4", "OFFICE", false],
  ]);
  expect(out.property.notes[1]).toMatchObject({ type: "INTERNAL", body: "Back gate sticks", createdAt: at });
  // without a viewer id nothing is "mine"; no author ids = no technician lookup
  const q = detailPrisma([{ id: "n9", type: "INTERNAL", body: "x", createdAt: at, authorProfileId: null }], []);
  const out2 = await createJobDetailService(q).getVisitDetail("v2");
  expect(out2.property.notes[0]).toMatchObject({ source: "OFFICE", mine: false });
  expect(q.technician.findMany).not.toHaveBeenCalled();
});

it("technician notes for the office store the author profile", async () => {
  const prisma: any = { visit: { findUnique: vi.fn().mockResolvedValue({ id: "v1", propertyId: "p1" }) }, propertyNote: { create: vi.fn() } };
  await createMediaService(prisma).addVisitNote("v1", "hello", "prof-tech");
  expect(prisma.propertyNote.create.mock.calls[0][0].data).toMatchObject({ authorProfileId: "prof-tech", type: "INTERNAL" });
  await createMediaService(prisma).addVisitNote("v1", "hello");
  expect(prisma.propertyNote.create.mock.calls[1][0].data.authorProfileId).toBeNull();
});

// ---- 4. pause in the past ---------------------------------------------------------------

function pausePrisma(settings: any = null) {
  const tx: any = { visit: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) }, servicePlan: { update: vi.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: "sp1", ...data })) } };
  return {
    businessSettings: { findFirst: vi.fn().mockResolvedValue(settings) },
    servicePlan: { findUnique: vi.fn().mockResolvedValue({ id: "sp1", propertyId: "p1", status: "ACTIVE", pauseStartDate: null }) },
    property: { findUnique: vi.fn().mockResolvedValue({ id: "p1", servicePlans: [{ id: "sp1", propertyId: "p1", status: "ACTIVE", pauseStartDate: null }] }) },
    $transaction: vi.fn((cb: any) => cb(tx)),
  } as any;
}

it("PAUSE_START_IN_PAST: a start before today (tenant time zone) is a 400 on both pause paths; today and future pass", async () => {
  const svc = createCustomerService(pausePrisma());
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);
  await expect(svc.pauseServicePlan("sp1", { pauseStartDate: day(-2) })).rejects.toMatchObject({ statusCode: 400, code: "PAUSE_START_IN_PAST" });
  await expect(svc.pauseService("p1", { pauseStartDate: day(-2) })).rejects.toMatchObject({ statusCode: 400, code: "PAUSE_START_IN_PAST" });
  await expect(svc.pauseServicePlan("sp1", { pauseStartDate: day(0) })).resolves.toMatchObject({ pauseScheduled: false });
  await expect(svc.pauseServicePlan("sp1", { pauseStartDate: day(5) })).resolves.toMatchObject({ pauseScheduled: true });
  // "today" follows the tenant zone (an Auckland tenant is up to a day ahead of UTC)
  const auckland = createCustomerService(pausePrisma({ timezone: "Pacific/Auckland" }));
  await expect(auckland.pauseServicePlan("sp1", { pauseStartDate: day(1) })).resolves.toBeDefined();
});

// ---- 3/2. customers without property, create with property, single property ----------------

function customerPrisma(over: Record<string, any> = {}) {
  const prisma: any = {
    businessSettings: { findFirst: vi.fn().mockResolvedValue({ defaultPaymentMethod: "BACS" }) },
    customer: { create: vi.fn().mockResolvedValue({ id: "c1", name: "Jo" }), findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    property: { create: vi.fn().mockResolvedValue({ id: "p1" }), findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    servicePlan: { create: vi.fn().mockResolvedValue({ id: "sp1" }) },
    round: { findUnique: vi.fn().mockResolvedValue(null) },
    serviceArea: { findUnique: vi.fn().mockResolvedValue({ id: "sa1" }) },
    service: { findUnique: vi.fn().mockResolvedValue({ id: "svc", active: true }) },
    invoice: { aggregate: vi.fn().mockResolvedValue({ _sum: { amount: 0 } }) },
    $transaction: vi.fn((cb: any) => cb(prisma)),
    ...over,
  };
  return prisma;
}
const propInput = { addressLine: "1 High St", postcode: "X1 1AA", serviceAreaId: "sa1", price: 20 };

it("POST /customers with a property creates customer + property + plan in one transaction", async () => {
  const prisma = customerPrisma();
  const out = await createCustomerService(prisma).createCustomerWithProperty({ name: "Jo", property: propInput as never });
  expect(out).toEqual({ customer: { id: "c1", name: "Jo" }, property: { propertyId: "p1", servicePlanId: "sp1", assigned: false } });
  expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  expect(prisma.servicePlan.create.mock.calls[0][0].data.paymentMethod).toBe("BACS");
  const withRound = customerPrisma({ round: { findUnique: vi.fn().mockResolvedValue({ id: "r1", serviceAreaId: "sa1", frequency: "FOUR_WEEKLY", defaultDay: "MON" }) } });
  const o2 = await createCustomerService(withRound).createCustomerWithProperty({ name: "Jo", paymentMethod: "CASH", property: { ...propInput, roundId: "r1", paymentMethod: "CHEQUE" } as never });
  expect(o2.property?.assigned).toBe(true);
  expect(withRound.servicePlan.create.mock.calls[0][0].data.paymentMethod).toBe("CHEQUE");
  expect(withRound.customer.create.mock.calls[0][0].data.paymentMethod).toBe("CASH");
});

it("create-with-property validates before writing anything; without property no property is created", async () => {
  const bad = customerPrisma({ round: { findUnique: vi.fn().mockResolvedValue({ id: "r1", serviceAreaId: "other", frequency: null, defaultDay: null }) } });
  await expect(createCustomerService(bad).createCustomerWithProperty({ name: "Jo", property: { ...propInput, roundId: "r1" } as never })).rejects.toMatchObject({ code: "ROUND_SERVICE_AREA_MISMATCH" });
  const inactive = customerPrisma({ service: { findUnique: vi.fn().mockResolvedValue({ id: "svc", active: false }) } });
  await expect(createCustomerService(inactive).createCustomerWithProperty({ name: "Jo", property: { ...propInput, serviceId: "svc" } as never })).rejects.toMatchObject({ code: "SERVICE_INACTIVE" });
  expect(bad.customer.create).not.toHaveBeenCalled();
  expect(inactive.customer.create).not.toHaveBeenCalled();
  const plain = customerPrisma();
  expect(await createCustomerService(plain).createCustomerWithProperty({ name: "Jo" })).toEqual({ customer: { id: "c1", name: "Jo" }, property: null });
  expect(plain.property.create).not.toHaveBeenCalled();
});

const propertyRow = (over: Record<string, unknown> = {}) => ({
  id: "p2", propertyName: "Annex", addressLine: "2 Low Rd", postcode: "X2", latitude: 1, longitude: 2, propertyType: "HOUSE", status: "ACTIVE",
  accessNotes: "Gate 1", riskNotes: null, serviceAreaId: "sa1", serviceArea: { name: "Wirral" }, roundId: "r1", round: { name: "Mon", defaultDay: "MON" },
  assignedTechnicianId: "t1", assignedTechnician: { id: "t1", name: "Sam" }, createdAt: new Date("2026-10-01T00:00:00Z"),
  customer: {
    id: "c1", name: "Jo", phone: "07", landline: null, email: null, status: "ACTIVE", paymentMethod: "CASH", badDebt: false, holdNextClean: false, messagesOptOut: false,
    payments: [{ status: "PAID" }], invoices: [{ status: "PAID", dueDate: null, amount: 10 }],
  },
  servicePlans: [{ id: "sp1", serviceId: "svc", service: { name: "Windows" }, price: 20, cleanMethod: null, paymentMethod: "CASH", cleaningFrequency: "FOUR_WEEKLY", status: "ACTIVE", nextDueDate: new Date("2026-12-01T00:00:00Z"), lastCompleted: null, pauseStartDate: null, pauseEndDate: null }],
  visits: [{ id: "v1", date: new Date("2026-11-10T00:00:00Z"), status: "SCHEDULED", technicianId: "t1", technician: { name: "Sam" }, paymentHold: false }],
  ...over,
});

it("GET /properties/:id returns the property with customer, plans, pause state, payment status and next visit", async () => {
  const prisma = customerPrisma();
  prisma.property.findUnique.mockResolvedValue(propertyRow());
  const out = await createCustomerService(prisma).getProperty("p2");
  expect(out).toMatchObject({
    id: "p2", customerId: "c1", serviceAreaName: "Wirral", roundName: "Mon", roundDefaultDay: "MON", assignedTechnicianName: "Sam",
    pause: { state: "NONE", pauseStartDate: null, pauseEndDate: null }, paymentStatus: "PAID", amountDue: 0,
    nextVisit: { id: "v1", technicianName: "Sam", paymentHold: false },
  });
  expect(out.customer).toMatchObject({ id: "c1", name: "Jo", paymentMethod: "CASH" });
  expect(out.servicePlans[0]).toMatchObject({ id: "sp1", serviceName: "Windows", price: 20, isPrimary: true });
});

it("GET /properties/:id pause states: PAUSED, SCHEDULED (future window on an ACTIVE plan), none/no plan/no visit, 404", async () => {
  const prisma = customerPrisma();
  const plan = (extra: Record<string, unknown>) => ({ ...propertyRow().servicePlans[0], ...extra });
  const start = new Date("2026-12-01T00:00:00Z");
  prisma.property.findUnique.mockResolvedValue(propertyRow({ servicePlans: [plan({ status: "PAUSED", pauseStartDate: start, pauseEndDate: null })] }));
  expect((await createCustomerService(prisma).getProperty("p2")).pause).toEqual({ state: "PAUSED", pauseStartDate: start, pauseEndDate: null });
  prisma.property.findUnique.mockResolvedValue(propertyRow({ servicePlans: [plan({ pauseStartDate: start })] }));
  expect((await createCustomerService(prisma).getProperty("p2")).pause.state).toBe("SCHEDULED");
  prisma.property.findUnique.mockResolvedValue(propertyRow({ servicePlans: [], visits: [], assignedTechnician: null, serviceArea: null, round: null, customer: { ...propertyRow().customer, payments: [], invoices: [], holdNextClean: true } }));
  const bare = await createCustomerService(prisma).getProperty("p2");
  expect(bare).toMatchObject({ servicePlans: [], pause: { state: "NONE" }, nextVisit: null, paymentStatus: "ON_HOLD", roundName: null, assignedTechnicianName: null, serviceAreaName: null });
  prisma.property.findUnique.mockResolvedValue({ ...propertyRow(), servicePlans: [plan({ status: "CANCELLED" })] });
  expect((await createCustomerService(prisma).getProperty("p2")).servicePlans[0].isPrimary).toBe(true);
  prisma.property.findUnique.mockResolvedValue(null);
  await expect(createCustomerService(prisma).getProperty("nope")).rejects.toMatchObject({ statusCode: 404, message: "Property not found" });
});

it("GET /customers/:id lists every property of the customer", async () => {
  const prisma = customerPrisma();
  const mkProp = (id: string, status: string, plans: any[]) => ({
    id, propertyName: null, addressLine: id, postcode: "X", status, roundId: null, round: null, serviceAreaId: "sa1", latitude: null, longitude: null, propertyType: null, accessNotes: null, riskNotes: null,
    servicePlans: plans, notes: [], photos: [], visits: [], serviceArea: null,
  });
  prisma.customer.findUnique = vi.fn().mockResolvedValue({
    id: "c1", name: "Jo", phone: null, email: null, status: "ACTIVE", ghlContactId: null, badDebt: false, holdNextClean: false,
    payments: [], invoices: [],
    properties: [
      mkProp("p1", "ACTIVE", [{ id: "a", service: null, status: "ACTIVE", price: 20, nextDueDate: new Date("2026-12-01T00:00:00Z"), cleaningFrequency: null, lastCompleted: null, pauseStartDate: null, pauseEndDate: null }]),
      mkProp("p2", "CANCELLED", []),
    ],
  });
  prisma.issue = { count: vi.fn().mockResolvedValue(0) };
  const out = await createCustomerService(prisma).getCustomerDetail("c1", UserRole.ADMIN);
  expect(out.properties.map((p) => [p.id, p.status, p.primaryPlanStatus, p.price])).toEqual([["p1", "ACTIVE", "ACTIVE", 20], ["p2", "CANCELLED", null, null]]);
  expect(out.properties[0].nextDueDate).toEqual(new Date("2026-12-01T00:00:00Z"));
});

it("GET /customers: a customer without a property is a hasNoProperty row, held and financial fields intact", async () => {
  const prisma = customerPrisma();
  prisma.customer.findMany.mockResolvedValue([
    { id: "c9", name: "Alone", status: "ACTIVE", holdNextClean: true, badDebt: true, payments: [], invoices: [{ status: "SENT", dueDate: null, amount: 12 }], properties: [] },
  ]);
  const admin = await createCustomerService(prisma).getCustomers({}, UserRole.ADMIN);
  expect(admin.customers[0]).toMatchObject({ customerId: "c9", hasNoProperty: true, paymentStatus: "ON_HOLD", badDebt: true, amountDue: 12, onHold: false });
  const tech = await createCustomerService(prisma).getCustomers({}, UserRole.TECHNICIAN);
  expect(tech.customers[0].amountDue).toBeUndefined();
});
