import { beforeEach, describe, expect, it, vi } from "vitest";
import { MailerError, SesMailer, buildDkimRecords, buildRawMime, mapIdentityStatus } from "../ses";

const cfg = { region: "eu-west-2", fromAddress: "notifications@mail.roundflow.ai", configurationSet: "rf-set", disabled: false } as const;

function awsError(name: string, status?: number) {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

let client: { send: ReturnType<typeof vi.fn> };
let sleep: ReturnType<typeof vi.fn>;
let mailer: SesMailer;
beforeEach(() => {
  client = { send: vi.fn().mockResolvedValue({ MessageId: "ses-1" }) };
  sleep = vi.fn().mockResolvedValue(undefined);
  mailer = new SesMailer(cfg, { client: client as never, sleep: sleep as never });
});

const email = {
  from: '"Acme" <notifications@mail.roundflow.ai>', replyTo: "owner@acme.co", to: "ann@example.com",
  subject: "Hello", html: "<p>Hi</p>", text: "Hi", tags: { tenantId: "t1", messageId: "m1" },
};

describe("SesMailer.send (simple)", () => {
  it("sends Simple content with tags, configuration set, reply-to", async () => {
    const r = await mailer.send(email);
    expect(r).toEqual({ messageId: "ses-1" });
    const input = client.send.mock.calls[0][0].input;
    expect(input).toMatchObject({
      FromEmailAddress: email.from, Destination: { ToAddresses: ["ann@example.com"] }, ReplyToAddresses: ["owner@acme.co"],
      ConfigurationSetName: "rf-set",
      EmailTags: [{ Name: "tenantId", Value: "t1" }, { Name: "messageId", Value: "m1" }],
      Content: { Simple: { Subject: { Data: "Hello", Charset: "UTF-8" }, Body: { Html: { Data: "<p>Hi</p>", Charset: "UTF-8" }, Text: { Data: "Hi", Charset: "UTF-8" } } } },
    });
    expect(client.send.mock.calls[0][1]).toHaveProperty("abortSignal");
  });
  it("omits optional fields", async () => {
    const m = new SesMailer({ region: "r", fromAddress: "a@b.co", disabled: false }, { client: client as never, sleep: sleep as never });
    await m.send({ from: "a@b.co", to: "x@y.co", subject: "s", html: "h", text: "t" });
    const input = client.send.mock.calls[0][0].input;
    expect(input.ReplyToAddresses).toBeUndefined();
    expect(input.ConfigurationSetName).toBeUndefined();
    expect(input.EmailTags).toBeUndefined();
  });
  it("strips CR/LF from the subject (header injection)", async () => {
    await mailer.send({ ...email, subject: "Hi\r\nBcc: evil@x.com" });
    expect(client.send.mock.calls[0][0].input.Content.Simple.Subject.Data).toBe("Hi Bcc: evil@x.com");
  });
  it("tag values are sanitised to SES-safe characters", async () => {
    await mailer.send({ ...email, tags: { tenantId: "t 1/é" } });
    expect(client.send.mock.calls[0][0].input.EmailTags).toEqual([{ Name: "tenantId", Value: "t_1__" }]);
  });
  it("throws when SES returns no message id", async () => {
    client.send.mockResolvedValue({});
    await expect(mailer.send(email)).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
  });
});

describe("SesMailer.send (attachments → raw)", () => {
  it("uses Raw content with a base64 attachment", async () => {
    await mailer.send({ ...email, attachments: [{ filename: "INV-1.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.4") }] });
    const input = client.send.mock.calls[0][0].input;
    expect(input.Content.Raw).toBeDefined();
    expect(input.Content.Simple).toBeUndefined();
    const raw = Buffer.from(input.Content.Raw.Data).toString("utf8");
    expect(raw).toContain("multipart/mixed");
    expect(raw).toContain('filename="INV-1.pdf"');
    expect(raw).toContain(Buffer.from("%PDF-1.4").toString("base64"));
    expect(input.EmailTags).toHaveLength(2);
  });
});

describe("buildRawMime", () => {
  it("builds headers, an alternative part and attachments; sanitises header values", () => {
    const raw = buildRawMime({
      ...email, subject: "Café\r\nX-Evil: 1", attachments: [{ filename: 'a"b\r\n.pdf', contentType: "application/pdf", content: Buffer.alloc(200, 1) }],
    }, "BOUNDARY");
    expect(raw).toContain(`From: ${email.from}`);
    expect(raw).toContain("To: ann@example.com");
    expect(raw).toContain("Reply-To: owner@acme.co");
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(raw).not.toMatch(/X-Evil/);
    expect(raw).toContain("--BOUNDARY--");
    expect(raw).toContain('filename="a_b_.pdf"');
    expect(raw.split("\r\n").every((l) => l.length <= 998)).toBe(true);
  });
  it("plain ASCII subject is not encoded; no reply-to header when absent", () => {
    const raw = buildRawMime({ from: "a@b.co", to: "c@d.co", subject: "Plain", html: "<p>x</p>", text: "x" }, "B");
    expect(raw).toContain("Subject: Plain\r\n");
    expect(raw).not.toContain("Reply-To");
  });
});

describe("retry and error mapping", () => {
  it("retries once on throttling then succeeds", async () => {
    client.send.mockRejectedValueOnce(awsError("ThrottlingException")).mockResolvedValueOnce({ MessageId: "ses-2" });
    await expect(mailer.send(email)).resolves.toEqual({ messageId: "ses-2" });
    expect(client.send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
  it("the default sleep waits before the retry", async () => {
    vi.useFakeTimers();
    try {
      const real = new SesMailer(cfg, { client: client as never });
      client.send.mockRejectedValueOnce(awsError("ThrottlingException")).mockResolvedValueOnce({ MessageId: "ses-3" });
      const p = real.send(email);
      await vi.advanceTimersByTimeAsync(600);
      await expect(p).resolves.toEqual({ messageId: "ses-3" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("retries once on a 5xx and gives up with PROVIDER_UNAVAILABLE", async () => {
    client.send.mockRejectedValue(awsError("InternalFailure", 503));
    await expect(mailer.send(email)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect(client.send).toHaveBeenCalledTimes(2);
  });
  it("also retries TooManyRequestsException and timeouts", async () => {
    client.send.mockRejectedValueOnce(awsError("TooManyRequestsException")).mockRejectedValueOnce(awsError("TimeoutError"));
    await expect(mailer.send(email)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(client.send).toHaveBeenCalledTimes(2);
  });
  it("does not retry a rejected message (4xx)", async () => {
    client.send.mockRejectedValue(awsError("MessageRejected", 400));
    await expect(mailer.send(email)).rejects.toMatchObject({ code: "PROVIDER_REJECTED", retryable: false });
    expect(client.send).toHaveBeenCalledTimes(1);
  });
  it("error messages and logs never contain the recipient address", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    client.send.mockRejectedValue(awsError("MessageRejected", 400));
    const err = (await mailer.send(email).catch((e) => e)) as MailerError;
    expect(String(err.message)).not.toContain("ann@example.com");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("ann@example.com");
    expect(JSON.stringify(spy.mock.calls)).toContain("t1");
    spy.mockRestore();
  });
  it("logs without tags too", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    client.send.mockRejectedValue(awsError("MessageRejected", 400));
    await mailer.send({ ...email, tags: undefined }).catch(() => undefined);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
  it("EMAIL_DISABLED and missing config short-circuit with typed errors", async () => {
    await expect(new SesMailer({ ...cfg, disabled: true }, { client: client as never }).send(email)).rejects.toMatchObject({ code: "EMAIL_DISABLED" });
    await expect(new SesMailer({ disabled: false }, { client: client as never }).send(email)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(client.send).not.toHaveBeenCalled();
  });
  it("a non-Error rejection is still mapped", async () => {
    client.send.mockRejectedValue("boom");
    await expect(mailer.send(email)).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
  });
});

describe("domain identities", () => {
  it("createIdentity requests Easy DKIM and returns the 3 CNAME records", async () => {
    client.send.mockResolvedValue({ DkimAttributes: { Tokens: ["a1", "b2", "c3"], Status: "PENDING" }, VerifiedForSendingStatus: false });
    const r = await mailer.createIdentity("acme.co.uk", { tenantId: "t1" });
    const input = client.send.mock.calls[0][0].input;
    expect(input).toMatchObject({ EmailIdentity: "acme.co.uk", DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" }, ConfigurationSetName: "rf-set" });
    expect(input.Tags).toEqual([{ Key: "tenantId", Value: "t1" }]);
    expect(r.status).toBe("PENDING");
    expect(r.records).toEqual([
      { type: "CNAME", name: "a1._domainkey.acme.co.uk", value: "a1.dkim.amazonses.com" },
      { type: "CNAME", name: "b2._domainkey.acme.co.uk", value: "b2.dkim.amazonses.com" },
      { type: "CNAME", name: "c3._domainkey.acme.co.uk", value: "c3.dkim.amazonses.com" },
    ]);
  });
  it("createIdentity adopts an existing identity only when it carries this tenant's tag", async () => {
    client.send
      .mockRejectedValueOnce(awsError("AlreadyExistsException", 400))
      .mockResolvedValueOnce({ DkimAttributes: { Tokens: ["a1", "b2", "c3"], Status: "SUCCESS" }, VerifiedForSendingStatus: true, Tags: [{ Key: "x", Value: "y" }, { Key: "tenantId", Value: "t1" }] });
    const r = await mailer.createIdentity("acme.co.uk", { tenantId: "t1" });
    expect(r.status).toBe("VERIFIED");
    expect(r.ownerTenantId).toBe("t1");
  });
  it("createIdentity refuses a domain registered by another tenant, an untagged one, or an unreadable one", async () => {
    for (const read of [
      { Tags: [{ Key: "tenantId", Value: "other" }] },
      { Tags: [] },
      {},
    ]) {
      client.send.mockRejectedValueOnce(awsError("AlreadyExistsException", 400)).mockResolvedValueOnce(read);
      await expect(mailer.createIdentity("acme.co.uk", { tenantId: "t1" })).rejects.toMatchObject({ code: "PROVIDER_REJECTED", awsName: "AlreadyExistsException" });
    }
    client.send.mockRejectedValueOnce(awsError("AlreadyExistsException", 400)).mockRejectedValueOnce(awsError("NotFoundException", 404));
    await expect(mailer.createIdentity("acme.co.uk", { tenantId: "t1" })).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
  });
  it("createIdentity rethrows other provider errors", async () => {
    client.send.mockRejectedValueOnce(awsError("LimitExceededException", 400));
    await expect(mailer.createIdentity("acme.co.uk", { tenantId: "t1" })).rejects.toMatchObject({ awsName: "LimitExceededException" });
  });
  it("getIdentity maps statuses and tolerates missing attributes", async () => {
    client.send.mockResolvedValue({ DkimAttributes: { Tokens: ["a"], Status: "FAILED" }, VerifiedForSendingStatus: false });
    expect((await mailer.getIdentity("acme.co.uk"))!.status).toBe("FAILED");
    client.send.mockResolvedValue({});
    expect(await mailer.getIdentity("acme.co.uk")).toEqual({ status: "PENDING", records: [] });
  });
  it("getIdentity returns null for NotFoundException", async () => {
    client.send.mockRejectedValue(awsError("NotFoundException", 404));
    expect(await mailer.getIdentity("acme.co.uk")).toBeNull();
  });
  it("deleteIdentity ignores NotFound and surfaces other failures", async () => {
    client.send.mockResolvedValue({});
    await mailer.deleteIdentity("acme.co.uk");
    expect(client.send.mock.calls[0][0].input).toEqual({ EmailIdentity: "acme.co.uk" });
    client.send.mockRejectedValue(awsError("NotFoundException", 404));
    await expect(mailer.deleteIdentity("acme.co.uk")).resolves.toBeUndefined();
    client.send.mockRejectedValue(awsError("AccessDenied", 403));
    await expect(mailer.deleteIdentity("acme.co.uk")).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
  });
  it("identity calls are blocked when disabled / unconfigured", async () => {
    await expect(new SesMailer({ disabled: true }, { client: client as never }).getIdentity("a.co")).rejects.toMatchObject({ code: "EMAIL_DISABLED" });
    await expect(new SesMailer({ disabled: false }, { client: client as never }).createIdentity("a.co", { tenantId: "t1" })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});

describe("helpers", () => {
  it("mapIdentityStatus", () => {
    expect(mapIdentityStatus("SUCCESS", true)).toBe("VERIFIED");
    expect(mapIdentityStatus("SUCCESS", false)).toBe("PENDING");
    expect(mapIdentityStatus("FAILED", false)).toBe("FAILED");
    expect(mapIdentityStatus("TEMPORARY_FAILURE", false)).toBe("PENDING");
    expect(mapIdentityStatus(undefined, undefined)).toBe("PENDING");
  });
  it("buildDkimRecords", () => {
    expect(buildDkimRecords("x.co", undefined)).toEqual([]);
  });
});

describe("default client construction", () => {
  it("builds a real SESv2 client from config (no network until send)", () => {
    const m = new SesMailer({ ...cfg, credentials: { accessKeyId: "AKIA", secretAccessKey: "s" } });
    expect(m).toBeInstanceOf(SesMailer);
    const m2 = new SesMailer({ disabled: false, region: "eu-west-2", fromAddress: "a@b.co" });
    expect(m2).toBeInstanceOf(SesMailer);
    expect(new SesMailer({ disabled: false })).toBeInstanceOf(SesMailer);
  });
});
