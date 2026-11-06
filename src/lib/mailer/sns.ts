import { createVerify } from "crypto";
import { outboundSignal } from "../outbound";

// Amazon SNS message authentication (GHL-07). SES publishes bounce/complaint/delivery events to an SNS topic which
// POSTs them to /webhooks/ses. Every message must be verified: the signing certificate URL has to be an
// https://sns.<region>.amazonaws.com URL (otherwise anyone could point us at their own certificate), and the
// signature is checked over the canonical string defined by AWS.

export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

export function isTrustedSnsUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && SNS_HOST.test(u.hostname) && !u.username && !u.password && u.port === "";
  } catch {
    return false;
  }
}

const NOTIFICATION_KEYS = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const;
const CONFIRMATION_KEYS = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"] as const;

export function stringToSign(msg: SnsMessage): string {
  const keys = msg.Type === "Notification" ? NOTIFICATION_KEYS : CONFIRMATION_KEYS;
  return keys
    .filter((k) => msg[k] !== undefined)
    .map((k) => `${k}\n${msg[k]}\n`)
    .join("");
}

const certCache = new Map<string, string>();
export function clearCertCache(): void {
  certCache.clear();
}

async function defaultFetchCert(url: string): Promise<string> {
  const res = await fetch(url, { signal: outboundSignal() });
  if (!res.ok) throw new Error(`certificate download failed (${res.status})`);
  return res.text();
}

export interface VerifyDeps {
  fetchCert?: (url: string) => Promise<string>;
  expectedTopicArn?: string;
}

export async function verifySnsMessage(msg: SnsMessage, deps: VerifyDeps = {}): Promise<boolean> {
  if (deps.expectedTopicArn && msg.TopicArn !== deps.expectedTopicArn) return false;
  const algorithm = msg.SignatureVersion === "1" ? "RSA-SHA1" : msg.SignatureVersion === "2" ? "RSA-SHA256" : null;
  if (!algorithm || !msg.Signature || !isTrustedSnsUrl(msg.SigningCertURL)) return false;
  try {
    let cert = certCache.get(msg.SigningCertURL);
    if (!cert) {
      cert = await (deps.fetchCert ?? defaultFetchCert)(msg.SigningCertURL);
      certCache.set(msg.SigningCertURL, cert);
    }
    const verifier = createVerify(algorithm);
    verifier.update(stringToSign(msg));
    return verifier.verify(cert, msg.Signature, "base64");
  } catch {
    return false;
  }
}

export interface ConfirmDeps {
  fetchUrl?: (url: string) => Promise<{ ok: boolean; status?: number }>;
}

/** Visits the SubscribeURL of a (verified) SubscriptionConfirmation, but only if it is an SNS URL. */
export async function confirmSubscription(msg: SnsMessage, deps: ConfirmDeps = {}): Promise<void> {
  if (!msg.SubscribeURL || !isTrustedSnsUrl(msg.SubscribeURL)) throw new Error("Untrusted SubscribeURL");
  const fetchUrl = deps.fetchUrl ?? ((url: string) => fetch(url, { signal: outboundSignal() }));
  const res = await fetchUrl(msg.SubscribeURL);
  if (!res.ok) throw new Error(`Subscription confirmation failed (${res.status})`);
}
