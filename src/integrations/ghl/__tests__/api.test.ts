import { describe, it, expect, vi, beforeEach } from "vitest";
import { __clearGhlCustomFieldCache, sendGhlMessage, setGhlContactCustomFields } from "../api";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

const ctx = { accessToken: "token-1", locationId: "loc-1" };

const CUSTOM_FIELDS_RESPONSE = {
  customFields: [
    { id: "fld-1", fieldKey: "contact.last_clean_date" },
    { id: "fld-2", fieldKey: "balance_owed" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  __clearGhlCustomFieldCache();
});

describe("setGhlContactCustomFields", () => {
  it("resolves bare and namespaced field keys and PUTs the matched ids", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(CUSTOM_FIELDS_RESPONSE))
      .mockResolvedValueOnce(jsonResponse({}));

    await setGhlContactCustomFields(ctx, "contact-1", { last_clean_date: "2026-03-05", balance_owed: 42 });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://services.leadconnectorhq.com/locations/loc-1/customFields",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token-1", Version: "v3" }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://services.leadconnectorhq.com/contacts/contact-1",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ Version: "v3" }),
        body: JSON.stringify({
          customFields: [
            { id: "fld-1", key: "last_clean_date", fieldValue: "2026-03-05" },
            { id: "fld-2", key: "balance_owed", fieldValue: 42 },
          ],
        }),
      })
    );
  });

  it("skips unknown keys (logs a warning) and only sends the ones that matched", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(jsonResponse(CUSTOM_FIELDS_RESPONSE))
      .mockResolvedValueOnce(jsonResponse({}));

    await setGhlContactCustomFields(ctx, "contact-1", { balance_owed: 10, round_name: "Tuesday Round" });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('custom field "round_name" not found'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ body: JSON.stringify({ customFields: [{ id: "fld-2", key: "balance_owed", fieldValue: 10 }] }) })
    );
    warnSpy.mockRestore();
  });

  it("does nothing (no PUT) when none of the requested keys are known", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(jsonResponse(CUSTOM_FIELDS_RESPONSE));

    await setGhlContactCustomFields(ctx, "contact-1", { round_name: "Tuesday Round" });

    expect(fetchMock).toHaveBeenCalledTimes(1); // only the field-list lookup, no PUT
    warnSpy.mockRestore();
  });

  it("caches the field list across calls for the same location within the TTL", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(CUSTOM_FIELDS_RESPONSE))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}));

    await setGhlContactCustomFields(ctx, "contact-1", { balance_owed: 1 });
    await setGhlContactCustomFields(ctx, "contact-2", { balance_owed: 2 });

    // One lookup of the field list, two PUTs — the second call reused the cache.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws when the custom-fields lookup fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "nope" }, false, 500));

    await expect(setGhlContactCustomFields(ctx, "contact-1", { balance_owed: 1 })).rejects.toThrow(
      /getCustomFields failed \(500\)/
    );
  });

  it("throws when the contact PUT fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(CUSTOM_FIELDS_RESPONSE))
      .mockResolvedValueOnce(jsonResponse({ error: "nope" }, false, 400));

    await expect(setGhlContactCustomFields(ctx, "contact-1", { balance_owed: 1 })).rejects.toThrow(
      /setCustomFields failed \(400\)/
    );
  });
});

describe("sendGhlMessage", () => {
  it("posts the message with the mapped channel type and returns GHL's message id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messageId: "ghl-m1" }));
    await expect(sendGhlMessage(ctx, "contact-1", "hi", "WHATSAPP")).resolves.toBe("ghl-m1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/conversations/messages");
    expect(JSON.parse(init.body)).toEqual({ type: "WhatsApp", contactId: "contact-1", message: "hi" });
  });

  it("defaults an unknown channel to Email and returns null without a message id or JSON body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(sendGhlMessage(ctx, "c", "hi", "PIGEON")).resolves.toBeNull();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).type).toBe("Email");
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.reject(new Error("no body")), text: () => Promise.resolve("") });
    await expect(sendGhlMessage(ctx, "c", "hi", "SMS")).resolves.toBeNull();
  });

  it("throws on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "nope" }, false, 422));
    await expect(sendGhlMessage(ctx, "c", "hi", "SMS")).rejects.toThrow(/sendMessage failed \(422\)/);
  });
});
