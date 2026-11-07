import { afterEach, describe, expect, it, vi } from "vitest";
import { createSign, generateKeyPairSync } from "crypto";
import { clearCertCache, confirmSubscription, isTrustedSnsUrl, stringToSign, verifySnsMessage, type SnsMessage } from "../sns";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
const CERT_URL = "https://sns.eu-west-2.amazonaws.com/SimpleNotificationService-abc.pem";

function signed(over: Partial<SnsMessage> = {}, version: "1" | "2" = "2"): SnsMessage {
  const msg: SnsMessage = {
    Type: "Notification", MessageId: "m-1", TopicArn: "arn:aws:sns:eu-west-2:123:ses", Message: '{"eventType":"Delivery"}',
    Timestamp: "2026-11-06T10:00:00.000Z", SignatureVersion: version, Signature: "", SigningCertURL: CERT_URL, ...over,
  };
  const signer = createSign(version === "2" ? "RSA-SHA256" : "RSA-SHA1");
  signer.update(stringToSign(msg));
  msg.Signature = signer.sign(privateKey, "base64");
  return msg;
}

afterEach(() => {
  clearCertCache();
  vi.unstubAllGlobals();
});

describe("isTrustedSnsUrl", () => {
  it("accepts https sns.<region>.amazonaws.com only", () => {
    expect(isTrustedSnsUrl(CERT_URL)).toBe(true);
    expect(isTrustedSnsUrl("https://sns.cn-north-1.amazonaws.com.cn/x.pem")).toBe(true);
    for (const bad of [
      "http://sns.eu-west-2.amazonaws.com/x.pem", "https://evil.com/sns.eu-west-2.amazonaws.com/x.pem",
      "https://sns.eu-west-2.amazonaws.com.evil.com/x.pem", "https://amazonaws.com/x.pem", "https://user@sns.eu-west-2.amazonaws.com/x.pem",
      "https://sns.eu-west-2.amazonaws.com:8443/x.pem", "not a url", "", "https://s3.eu-west-2.amazonaws.com/x.pem",
    ]) expect(isTrustedSnsUrl(bad)).toBe(false);
  });
});

describe("stringToSign", () => {
  it("Notification: only the documented keys, in order, Subject only when present", () => {
    const m = signed();
    expect(stringToSign(m)).toBe(
      `Message\n{"eventType":"Delivery"}\nMessageId\nm-1\nTimestamp\n2026-11-06T10:00:00.000Z\nTopicArn\narn:aws:sns:eu-west-2:123:ses\nType\nNotification\n`
    );
    expect(stringToSign({ ...m, Subject: "Hi" })).toContain("Subject\nHi\nTimestamp");
  });
  it("SubscriptionConfirmation / UnsubscribeConfirmation include SubscribeURL and Token", () => {
    const s = stringToSign({ ...signed(), Type: "SubscriptionConfirmation", SubscribeURL: "https://sns.eu-west-2.amazonaws.com/?x=1", Token: "tok" });
    expect(s).toContain("SubscribeURL\nhttps://sns.eu-west-2.amazonaws.com/?x=1\n");
    expect(s).toContain("Token\ntok\n");
  });
});

describe("verifySnsMessage", () => {
  const fetchCert = vi.fn();
  it("accepts a correctly signed message (v2 and v1)", async () => {
    fetchCert.mockResolvedValue(publicPem);
    expect(await verifySnsMessage(signed(), { fetchCert })).toBe(true);
    expect(await verifySnsMessage(signed({}, "1"), { fetchCert })).toBe(true);
  });
  it("caches the certificate per URL", async () => {
    fetchCert.mockReset().mockResolvedValue(publicPem);
    await verifySnsMessage(signed(), { fetchCert });
    await verifySnsMessage(signed({ MessageId: "m-2" }), { fetchCert });
    expect(fetchCert).toHaveBeenCalledTimes(1);
  });
  it("rejects a tampered message, a wrong version, a missing signature", async () => {
    fetchCert.mockResolvedValue(publicPem);
    expect(await verifySnsMessage({ ...signed(), Message: "{}" }, { fetchCert })).toBe(false);
    expect(await verifySnsMessage({ ...signed(), SignatureVersion: "3" }, { fetchCert })).toBe(false);
    expect(await verifySnsMessage({ ...signed(), Signature: "" }, { fetchCert })).toBe(false);
  });
  it("rejects an untrusted certificate URL without fetching it", async () => {
    fetchCert.mockReset();
    expect(await verifySnsMessage(signed({ SigningCertURL: "https://evil.com/x.pem" }), { fetchCert })).toBe(false);
    expect(fetchCert).not.toHaveBeenCalled();
  });
  it("rejects when the certificate cannot be fetched or is garbage", async () => {
    fetchCert.mockReset().mockRejectedValue(new Error("down"));
    expect(await verifySnsMessage(signed(), { fetchCert })).toBe(false);
    clearCertCache();
    fetchCert.mockReset().mockResolvedValue("not a pem");
    expect(await verifySnsMessage(signed(), { fetchCert })).toBe(false);
  });
  it("rejects when the topic does not match the configured one", async () => {
    fetchCert.mockReset().mockResolvedValue(publicPem);
    expect(await verifySnsMessage(signed(), { fetchCert, expectedTopicArn: "arn:aws:sns:eu-west-2:123:other" })).toBe(false);
    expect(await verifySnsMessage(signed(), { fetchCert, expectedTopicArn: "arn:aws:sns:eu-west-2:123:ses" })).toBe(true);
  });
  it("the default fetcher downloads the cert with a timeout and fails on a bad status", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, text: async () => publicPem });
    vi.stubGlobal("fetch", f);
    expect(await verifySnsMessage(signed())).toBe(true);
    expect(f).toHaveBeenCalledWith(CERT_URL, expect.objectContaining({ signal: expect.anything() }));
    clearCertCache();
    f.mockResolvedValue({ ok: false, status: 500, text: async () => "" });
    expect(await verifySnsMessage(signed())).toBe(false);
  });
});

describe("confirmSubscription", () => {
  const sub = (url: string): SnsMessage => ({ ...signed(), Type: "SubscriptionConfirmation", SubscribeURL: url, Token: "t" });
  it("GETs a trusted SubscribeURL", async () => {
    const fetchUrl = vi.fn().mockResolvedValue({ ok: true });
    await confirmSubscription(sub("https://sns.eu-west-2.amazonaws.com/?Action=ConfirmSubscription&Token=t"), { fetchUrl });
    expect(fetchUrl).toHaveBeenCalledWith("https://sns.eu-west-2.amazonaws.com/?Action=ConfirmSubscription&Token=t");
  });
  it("refuses an untrusted or missing SubscribeURL and surfaces a failed confirmation", async () => {
    const fetchUrl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(confirmSubscription(sub("https://evil.com/confirm"), { fetchUrl })).rejects.toThrow(/untrusted/i);
    await expect(confirmSubscription({ ...sub(""), SubscribeURL: undefined }, { fetchUrl })).rejects.toThrow(/untrusted/i);
    await expect(confirmSubscription(sub("https://sns.eu-west-2.amazonaws.com/?x"), { fetchUrl })).rejects.toThrow(/500/);
  });
  it("the default fetcher uses fetch with a timeout", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", f);
    await confirmSubscription(sub("https://sns.eu-west-2.amazonaws.com/?x"));
    expect(f).toHaveBeenCalledWith("https://sns.eu-west-2.amazonaws.com/?x", expect.objectContaining({ signal: expect.anything() }));
  });
});
