import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";

const tenantFindUnique = vi.fn();
vi.mock("../../lib/prisma", () => ({ prisma: { tenant: { findUnique: (...a: unknown[]) => tenantFindUnique(...a) } } }));
const tp = { id: "tp" };
vi.mock("../../lib/tenant-prisma-manager", () => ({ getTenantPrismaForSchema: () => tp }));
const verifySnsMessage = vi.fn();
const confirmSubscription = vi.fn();
vi.mock("../../lib/mailer/sns", () => ({
  verifySnsMessage: (...a: unknown[]) => verifySnsMessage(...a),
  confirmSubscription: (...a: unknown[]) => confirmSubscription(...a),
}));
const applySesEvent = vi.fn();
vi.mock("../../services/email-events.service", async () => {
  const actual = await vi.importActual<typeof import("../../services/email-events.service")>("../../services/email-events.service");
  return { ...actual, applySesEvent: (...a: unknown[]) => applySesEvent(...a) };
});
const processWebhookEvent = vi.fn();
vi.mock("../../services/webhook-events.service", () => ({ processWebhookEvent: (...a: unknown[]) => processWebhookEvent(...a) }));

import { handleSesPayload, sesWebhookRouter } from "../sesWebhook";

const app = express();
app.use("/webhooks/ses", express.raw({ type: () => true }), sesWebhookRouter);

const inner = { eventType: "Bounce", mail: { messageId: "ses-1", tags: { tenantId: ["ten1"] } }, bounce: { bounceType: "Permanent", bounceSubType: "General" } };
const notification = (over: Record<string, unknown> = {}) => ({ Type: "Notification", MessageId: "sns-1", Message: JSON.stringify(inner), ...over });
const post = (body: unknown) => request(app).post("/webhooks/ses").set("Content-Type", "text/plain").send(typeof body === "string" ? body : JSON.stringify(body));

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SES_SNS_TOPIC_ARN;
  verifySnsMessage.mockResolvedValue(true);
  confirmSubscription.mockResolvedValue(undefined);
  tenantFindUnique.mockResolvedValue({ schemaName: "t_aaaaaaaaaaaaaaaaaaaa" });
  processWebhookEvent.mockImplementation(async (_tp, _s, _id, _p, handler: () => Promise<void>) => {
    await handler();
    return "done";
  });
});

describe("POST /webhooks/ses", () => {
  it("400 on malformed JSON, 403 on a bad signature (nothing processed)", async () => {
    expect((await post("{nope")).status).toBe(400);
    verifySnsMessage.mockResolvedValue(false);
    const res = await post(notification());
    expect(res.status).toBe(403);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });
  it("verifies against the configured topic ARN", async () => {
    process.env.SES_SNS_TOPIC_ARN = "arn:aws:sns:eu-west-2:1:ses";
    await post(notification());
    expect(verifySnsMessage).toHaveBeenCalledWith(expect.anything(), { expectedTopicArn: "arn:aws:sns:eu-west-2:1:ses" });
  });
  it("confirms a SubscriptionConfirmation; a failed confirmation is 500 so SNS retries", async () => {
    const res = await post({ Type: "SubscriptionConfirmation", MessageId: "s1", SubscribeURL: "https://sns.eu-west-2.amazonaws.com/?x" });
    expect(res.status).toBe(200);
    expect(confirmSubscription).toHaveBeenCalled();
    confirmSubscription.mockRejectedValue(new Error("untrusted"));
    expect((await post({ Type: "SubscriptionConfirmation", MessageId: "s1" })).status).toBe(500);
  });
  it("acknowledges an UnsubscribeConfirmation and unknown types without doing anything", async () => {
    expect((await post({ Type: "UnsubscribeConfirmation", MessageId: "u" })).status).toBe(200);
    expect((await post({ Type: "Weird", MessageId: "w" })).status).toBe(200);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });
  it("routes a Notification to the right tenant through the idempotent webhook state machine", async () => {
    const res = await post(notification());
    expect(res.status).toBe(200);
    expect(tenantFindUnique).toHaveBeenCalledWith({ where: { id: "ten1" }, select: { schemaName: true } });
    expect(processWebhookEvent).toHaveBeenCalledWith(tp, "ses", "sns-1", inner, expect.any(Function));
    expect(applySesEvent).toHaveBeenCalledWith(tp, expect.objectContaining({ type: "Bounce", messageId: "ses-1", permanent: true }));
  });
  it("a failed effect answers 500 so SNS redelivers; a duplicate is 200", async () => {
    processWebhookEvent.mockResolvedValue("failed");
    expect((await post(notification())).status).toBe(500);
    processWebhookEvent.mockResolvedValue("duplicate");
    expect((await post(notification())).status).toBe(200);
  });
  it("ignores notifications it cannot attribute (bad inner JSON, other event types, no/unknown tenant)", async () => {
    expect((await post(notification({ Message: "not json" }))).status).toBe(200);
    expect((await post(notification({ Message: JSON.stringify({ eventType: "Send", mail: { messageId: "x", tags: { tenantId: ["ten1"] } } }) }))).status).toBe(200);
    expect((await post(notification({ Message: JSON.stringify({ eventType: "Delivery", mail: { messageId: "x" } }) }))).status).toBe(200);
    tenantFindUnique.mockResolvedValue(null);
    expect((await post(notification())).status).toBe(200);
    expect(processWebhookEvent).not.toHaveBeenCalled();
  });
});

describe("handleSesPayload (retry sweep)", () => {
  it("re-applies a stored event; ignores an unparseable one", async () => {
    await handleSesPayload(tp as never, inner);
    expect(applySesEvent).toHaveBeenCalledTimes(1);
    await handleSesPayload(tp as never, { eventType: "Send" });
    expect(applySesEvent).toHaveBeenCalledTimes(1);
  });
});
