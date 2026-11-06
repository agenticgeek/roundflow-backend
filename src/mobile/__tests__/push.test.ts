import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { channelForType, pushToProfile } from "../services/push";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const prismaWith = (tokens: string[]) => ({ device: { findMany: vi.fn().mockResolvedValue(tokens.map((pushToken) => ({ pushToken }))) } });

describe("pushToProfile", () => {
  it("no-ops without Expo devices", async () => {
    await pushToProfile(prismaWith(["fcm-raw"]) as never, "p1", "t");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends title/body and, when given, the deep-link data", async () => {
    await pushToProfile(prismaWith(["ExponentPushToken[a]"]) as never, "p1", "T", "B", { roundId: "r1" });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent).toEqual([{ to: "ExponentPushToken[a]", title: "T", body: "B", sound: "default", channelId: "alerts", data: { roundId: "r1" } }]);
  });

  it("omits data and sends an empty body when none is given; adds the access token header when set", async () => {
    process.env.EXPO_ACCESS_TOKEN = "tok";
    try {
      await pushToProfile(prismaWith(["ExponentPushToken[a]"]) as never, "p1", "T");
      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual([{ to: "ExponentPushToken[a]", title: "T", body: "", sound: "default", channelId: "alerts" }]);
      expect(init.headers.Authorization).toBe("Bearer tok");
    } finally {
      delete process.env.EXPO_ACCESS_TOKEN;
    }
  });

  it("includes type in data and the matching channelId (type-only pushes get a data object too)", async () => {
    await pushToProfile(prismaWith(["ExponentPushToken[a]"]) as never, "p1", "T", "B", { roundId: "r1" }, "SCHEDULE");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)[0]).toMatchObject({ channelId: "schedule", data: { roundId: "r1", type: "SCHEDULE" } });
    await pushToProfile(prismaWith(["ExponentPushToken[a]"]) as never, "p1", "T", undefined, undefined, "CHAT");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)[0]).toMatchObject({ channelId: "chat", data: { type: "CHAT" } });
  });

  it("maps notification types to channels: schedule | chat | payments | alerts", () => {
    expect(["SCHEDULE", "ROUND_UPDATE", "DAY_CLOSED"].map(channelForType)).toEqual(["schedule", "schedule", "schedule"]);
    expect(channelForType("CHAT")).toBe("chat");
    expect(channelForType("PAYMENT")).toBe("payments");
    for (const t of ["COMPLAINT", "ACCESS_ISSUE", "INVITE", "KPI_ALERT", "INTEGRATION", "WHATEVER", undefined]) expect(channelForType(t)).toBe("alerts");
  });

  it("throws when Expo rejects the request", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "bad" });
    await expect(pushToProfile(prismaWith(["ExponentPushToken[a]"]) as never, "p1", "T")).rejects.toThrow("Expo push 500: bad");
  });
});
