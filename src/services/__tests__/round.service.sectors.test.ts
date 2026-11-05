import { it, expect, vi } from "vitest";
import { createRoundService } from "../round.service";
import {
  optPostcodeSectors,
  parseAreaSectors,
  assertSectorsInServiceArea,
} from "../../lib/postcode-sectors";

const bad = (fn: () => unknown) => expect(fn).toThrow(expect.objectContaining({ statusCode: 400 }));

it("BUG-04 optPostcodeSectors normalises, dedupes and validates", () => {
  expect(optPostcodeSectors(undefined)).toBeUndefined();
  expect(optPostcodeSectors([])).toEqual([]);
  expect(optPostcodeSectors([" ch41 ", "CH41", "ch41  2", "L1"])).toEqual(["CH41", "CH41 2", "L1"]);
  bad(() => optPostcodeSectors("CH41"));
  bad(() => optPostcodeSectors([1]));
  bad(() => optPostcodeSectors(["hello"]));
});

it("BUG-04 sectors must sit inside the service area's sector(s) when it records any", () => {
  expect(parseAreaSectors(null)).toEqual([]);
  expect(parseAreaSectors("CH41, ch42 ;L1")).toEqual(["CH41", "CH42", "L1"]);
  expect(() => assertSectorsInServiceArea(["CH41 2", "CH42"], { postcodeSector: "CH41, CH42" })).not.toThrow();
  expect(() => assertSectorsInServiceArea(["X1"], { postcodeSector: null })).not.toThrow();
  expect(() => assertSectorsInServiceArea(["X1"], null)).not.toThrow();
  bad(() => assertSectorsInServiceArea(["CH43"], { name: "Wirral", postcodeSector: "CH41" }));
  bad(() => assertSectorsInServiceArea(["CH43"], { postcodeSector: "CH41" }));
});

function makePrisma() {
  return {
    round: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    serviceArea: { findUnique: vi.fn() },
  };
}
const roundRow = (extra = {}) => ({
  id: "r1", name: "A", frequency: "FOUR_WEEKLY", status: "ACTIVE", defaultDay: null, description: null,
  serviceAreaId: "sa1", serviceArea: null, roundTechnicians: [], _count: { properties: 0 }, postcodeSectors: ["CH41"], ...extra,
});

it("BUG-04 createRound stores and returns postcodeSectors, rejecting sectors outside the area", async () => {
  const p = makePrisma();
  p.serviceArea.findUnique.mockResolvedValue({ id: "sa1", name: "Wirral", postcodeSector: "CH41" });
  p.round.create.mockResolvedValue(roundRow());
  const svc = createRoundService(p as never);
  const out = await svc.createRound({ name: "A", frequency: "FOUR_WEEKLY" as never, serviceAreaId: "sa1", postcodeSectors: ["CH41"] });
  expect(out.postcodeSectors).toEqual(["CH41"]);
  expect(p.round.create.mock.calls[0][0].data.postcodeSectors).toEqual(["CH41"]);
  await expect(
    svc.createRound({ name: "A", frequency: "FOUR_WEEKLY" as never, serviceAreaId: "sa1", postcodeSectors: ["L1"] })
  ).rejects.toMatchObject({ statusCode: 400 });
  p.round.create.mockClear();
  await svc.createRound({ name: "A", frequency: "FOUR_WEEKLY" as never, serviceAreaId: "sa1" });
  expect(p.round.create.mock.calls[0][0].data.postcodeSectors).toEqual([]);
});

it("BUG-04 updateRound validates against the new or current service area; null area skips the check", async () => {
  const p = makePrisma();
  p.round.findUnique.mockResolvedValue({ id: "r1", serviceArea: { name: "Wirral", postcodeSector: "CH41" } });
  p.round.update.mockResolvedValue(roundRow({ postcodeSectors: ["CH41 2"] }));
  const svc = createRoundService(p as never);
  // current area (not changed)
  await svc.updateRound("r1", { postcodeSectors: ["CH41 2"] });
  expect(p.round.update.mock.calls[0][0].data.postcodeSectors).toEqual(["CH41 2"]);
  await expect(svc.updateRound("r1", { postcodeSectors: ["L1"] })).rejects.toMatchObject({ statusCode: 400 });
  // round has no current area
  p.round.findUnique.mockResolvedValue({ id: "r1", serviceArea: null });
  await svc.updateRound("r1", { postcodeSectors: ["L1"] });
  // new area supplied in the same request
  p.serviceArea.findUnique.mockResolvedValue({ id: "sa2", name: "Liverpool", postcodeSector: "L1" });
  await svc.updateRound("r1", { serviceAreaId: "sa2", postcodeSectors: ["L1"] });
  await expect(svc.updateRound("r1", { serviceAreaId: "sa2", postcodeSectors: ["CH41"] })).rejects.toMatchObject({ statusCode: 400 });
  // unassigning the area (null) skips the area check; [] clears without a check
  await svc.updateRound("r1", { serviceAreaId: null, postcodeSectors: ["CH41"] });
  await svc.updateRound("r1", { postcodeSectors: [] });
});

it("BUG-04 listRounds returns postcodeSectors", async () => {
  const p = makePrisma();
  p.round.findMany.mockResolvedValue([{ ...roundRow(), serviceArea: { name: "Wirral" }, _count: { roundTechnicians: 1, properties: 2 } }]);
  const out = await createRoundService(p as never).listRounds();
  expect(out[0].postcodeSectors).toEqual(["CH41"]);
});
