import { it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../middleware/requireAuth", () => ({ requireAuth: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireTenantAccess", () => ({ requireTenantAccess: (_q: any, _s: any, n: any) => n() }));
vi.mock("../../middleware/requireRole", () => ({ requireBusinessAccess: () => (_q: any, _s: any, n: any) => n() }));
vi.mock("../../services/reports.service", () => ({ createReportsService: () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }) }));

const setServices = vi.fn();
const history = vi.fn();
vi.mock("../../services/property-services", () => ({ createPropertyServicesService: () => ({ setServices, history }) }));
const assignVisit = vi.fn();
vi.mock("../../services/visit.service", () => ({ createVisitService: () => ({ assignVisit, createVisit: vi.fn() }) }));
const listProperties = vi.fn();
const createRound = vi.fn();
const updateRound = vi.fn();
vi.mock("../../services/round.service", () => ({ createRoundService: () => ({ listProperties, createRound, updateRound }) }));
const closeDay = vi.fn();
vi.mock("../../services/today.service", () => ({ createTodayService: () => ({ closeDay, getTodaysWork: vi.fn() }) }));

import { propertiesRouter } from "../properties";
import { visitsRouter } from "../visits";
import { roundsRouter } from "../rounds";
import { todayRouter } from "../today";
import { errorHandler } from "../../lib/error-handler";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.tenantPrisma = {};
    req.profile = { id: "prof1", role: "ADMIN" };
    next();
  });
  app.use("/properties", propertiesRouter);
  app.use("/visits", visitsRouter);
  app.use("/rounds", roundsRouter);
  app.use("/today", todayRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => vi.clearAllMocks());

it("PUT /properties/:id/services validates the body and forwards actor + prices", async () => {
  setServices.mockResolvedValue({ propertyId: "p1", servicePlans: [], totalPrice: 0 });
  const ok = await request(makeApp()).put("/properties/p1/services").send({ serviceIds: ["a", "b"], prices: { b: 12.5 } });
  expect(ok.status).toBe(200);
  expect(setServices).toHaveBeenCalledWith("p1", { serviceIds: ["a", "b"], prices: { b: 12.5 } }, { id: "prof1", role: "ADMIN" });
  await request(makeApp()).put("/properties/p1/services").send({ serviceIds: ["a"] });
  expect(setServices).toHaveBeenLastCalledWith("p1", { serviceIds: ["a"], prices: undefined }, expect.anything());

  for (const body of [{}, { serviceIds: [] }, { serviceIds: "a" }, { serviceIds: ["a"], prices: { a: -1 } }, { serviceIds: ["a"], prices: { a: "x" } }, { serviceIds: ["a"], prices: [] }]) {
    expect((await request(makeApp()).put("/properties/p1/services").send(body)).status).toBe(400);
  }
  const empty = await request(makeApp()).put("/properties/p1/services").send({ serviceIds: [] });
  expect(empty.body.code).toBe("SERVICES_REQUIRED");
});

it("GET /properties/:id/services/history pages", async () => {
  history.mockResolvedValue({ rows: [], pagination: {} });
  await request(makeApp()).get("/properties/p1/services/history?page=2&pageSize=5");
  expect(history).toHaveBeenCalledWith("p1", 2, 5);
  await request(makeApp()).get("/properties/p1/services/history");
  expect(history).toHaveBeenLastCalledWith("p1", 1, 20);
});

it("PATCH /visits/:id/assign assigns, unassigns and requires the field", async () => {
  assignVisit.mockResolvedValue({ id: "v1" });
  expect((await request(makeApp()).patch("/visits/v1/assign").send({ technicianId: "t1" })).status).toBe(200);
  expect(assignVisit).toHaveBeenLastCalledWith("v1", "t1");
  await request(makeApp()).patch("/visits/v1/assign").send({ technicianId: null });
  expect(assignVisit).toHaveBeenLastCalledWith("v1", null);
  await request(makeApp()).patch("/visits/v1/assign").send({ technicianId: "" });
  expect(assignVisit).toHaveBeenLastCalledWith("v1", null);
  expect((await request(makeApp()).patch("/visits/v1/assign").send({})).status).toBe(400);
  expect((await request(makeApp()).patch("/visits/v1/assign").send({ technicianId: 5 })).status).toBe(400);
});

it("GET /rounds/:id/properties pages beyond 100", async () => {
  listProperties.mockResolvedValue({ rows: [], pagination: { total: 450 } });
  await request(makeApp()).get("/rounds/r1/properties?page=5&pageSize=100");
  expect(listProperties).toHaveBeenCalledWith("r1", 5, 100);
  await request(makeApp()).get("/rounds/r1/properties");
  expect(listProperties).toHaveBeenLastCalledWith("r1", 1, 50);
  expect((await request(makeApp()).get("/rounds/r1/properties?page=-1")).status).toBe(400);
});

it("round create/update accept and validate postcodeSectors", async () => {
  createRound.mockResolvedValue({ id: "r1" });
  updateRound.mockResolvedValue({ id: "r1" });
  const create = await request(makeApp()).post("/rounds").send({ name: "A", frequency: "FOUR_WEEKLY", serviceAreaId: "sa1", postcodeSectors: ["ch41", "CH41 2"] });
  expect(create.status).toBe(201);
  expect(createRound.mock.calls[0][0].postcodeSectors).toEqual(["CH41", "CH41 2"]);
  await request(makeApp()).patch("/rounds/r1").send({ postcodeSectors: [] });
  expect(updateRound.mock.calls[0][1].postcodeSectors).toEqual([]);
  await request(makeApp()).patch("/rounds/r1").send({ name: "B" });
  expect(updateRound.mock.calls[1][1].postcodeSectors).toBeUndefined();
  expect((await request(makeApp()).post("/rounds").send({ name: "A", frequency: "FOUR_WEEKLY", serviceAreaId: "sa1", postcodeSectors: ["nonsense!"] })).status).toBe(400);
  expect((await request(makeApp()).patch("/rounds/r1").send({ postcodeSectors: "CH41" })).status).toBe(400);
});

it("POST /today/close forwards skipReason", async () => {
  closeDay.mockResolvedValue({});
  await request(makeApp()).post("/today/close").send({ unfinishedAction: "mark_as_skipped", skipReason: "Rain" });
  expect(closeDay).toHaveBeenLastCalledWith("mark_as_skipped", "Rain");
  await request(makeApp()).post("/today/close").send({ unfinishedAction: "push_to_tomorrow" });
  expect(closeDay).toHaveBeenLastCalledWith("push_to_tomorrow", undefined);
  expect((await request(makeApp()).post("/today/close").send({ unfinishedAction: "x" })).status).toBe(400);
});
