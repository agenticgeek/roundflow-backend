import { it, expect, vi } from "vitest";
import { makeChatTenant } from "../../test/chat-fake";
import { createChatService } from "../services/chat.service";

const viewer = { profileId: "tech1", supabaseUserId: "sb-tech1" };

it("technician sends are TECHNICIAN rows; duplicate clientMsgId returns the same row", async () => {
  const t = makeChatTenant();
  const svc = createChatService(t.tp);
  const a = await svc.send("r1", "tech1", { type: "TEXT", text: "hi", clientMsgId: "c1" });
  const b = await svc.send("r1", "tech1", { type: "TEXT", text: "hi", clientMsgId: "c1" });
  expect(a.duplicate).toBe(false);
  expect(b.duplicate).toBe(true);
  expect(b.row.id).toBe(a.row.id);
  expect(a.row).toMatchObject({ senderRole: "TECHNICIAN", isMine: true });
  expect(t.messages).toHaveLength(1);
});

it("a create that loses a unique race falls back to the winner's row; other errors propagate", async () => {
  const t = makeChatTenant();
  const svc = createChatService(t.tp);
  const first = await svc.send("r1", "tech1", { type: "TEXT", text: "x", clientMsgId: "c1" });
  // simulate: the pre-check misses (race), create hits the unique index, then the re-read finds the winner
  const realFindFirst = t.tp.chatMessage.findFirst;
  t.tp.chatMessage.findFirst = vi.fn().mockResolvedValueOnce(null).mockImplementation(realFindFirst);
  const raced = await svc.send("r1", "tech1", { type: "TEXT", text: "x", clientMsgId: "c1" });
  expect(raced).toMatchObject({ duplicate: true, row: { id: first.row.id } });
  t.tp.chatMessage.create = vi.fn().mockRejectedValue(new Error("db down"));
  await expect(svc.send("r1", "tech1", { type: "TEXT", text: "y", clientMsgId: "c2" })).rejects.toThrow("db down");
  await expect(svc.send("r1", "tech1", { type: "TEXT", text: "z" })).rejects.toThrow("db down");
});

it("unread counts cover assigned rounds and rounds with a recent visit; read clears them", async () => {
  const t = makeChatTenant({
    rounds: [{ id: "r1", name: "A" }, { id: "r2", name: "B" }, { id: "r3", name: "C" }],
    roundTechnicians: [{ roundId: "r1", technicianId: "t1", technician: {} }],
    visits: [{ roundId: "r2", technicianId: "t1" }],
  });
  const svc = createChatService(t.tp);
  for (const roundId of ["r1", "r2", "r3"]) {
    await t.tp.chatMessage.create({ data: { roundId, senderProfileId: "office1", senderRole: "OFFICE", type: "TEXT", body: "hi", photoUrls: [] } });
  }
  await svc.send("r1", "tech1", { type: "TEXT", text: "mine" });
  const all = await svc.unread("t1", viewer);
  expect(all).toEqual({ total: 2, rounds: [{ roundId: "r1", unread: 1 }, { roundId: "r2", unread: 1 }] }); // r3 not a member round
  expect(await svc.unread("t1", viewer, "r1")).toEqual({ total: 1, rounds: [{ roundId: "r1", unread: 1 }] });

  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(t.lastTs() + 5000));
  await svc.markRead("r1", viewer);
  vi.useRealTimers();
  expect((await svc.unread("t1", viewer)).rounds).toEqual([{ roundId: "r2", unread: 1 }]);
  // no rounds at all
  expect(await createChatService(makeChatTenant().tp).unread("tx", viewer)).toEqual({ total: 0, rounds: [] });
});

it("listing returns office rows with senderRole and isMine=false for the technician", async () => {
  const t = makeChatTenant();
  const svc = createChatService(t.tp);
  await t.tp.chatMessage.create({ data: { roundId: "r1", senderProfileId: "office1", senderRole: "OFFICE", type: "TEXT", body: "reply", photoUrls: [] } });
  const rows = await svc.getChatMessages("r1", viewer);
  expect(rows[0]).toMatchObject({ senderRole: "OFFICE", isMine: false });
});
