import { randomBytes } from "crypto";
import {
  CreateEmailIdentityCommand, DeleteEmailIdentityCommand, GetEmailIdentityCommand, SendEmailCommand, SESv2Client,
} from "@aws-sdk/client-sesv2";
import { outboundSignal } from "../outbound";
import type { MailerConfig } from "./config";

// Amazon SES v2 provider (GHL-03). One outbound timeout (BE-09), one retry on throttling / 5xx, structured logging
// that never contains the recipient address (BE-18), and tenantId + messageId attached as SES message tags so
// bounce/complaint events map back to the right tenant and message.

export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutboundEmail {
  from: string;
  replyTo?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
  tags?: Record<string, string>;
}

export interface DkimRecord {
  type: "CNAME";
  name: string;
  value: string;
}

export type IdentityStatus = "PENDING" | "VERIFIED" | "FAILED";

export interface IdentityInfo {
  status: IdentityStatus;
  records: DkimRecord[];
  /** Value of the `tenantId` tag on the SES identity (who registered it), when read from SES. */
  ownerTenantId?: string;
}

/** The provider contract the rest of the app depends on (swappable; tests inject a fake). */
export interface MailProvider {
  send(email: OutboundEmail): Promise<{ messageId: string }>;
  createIdentity(domain: string, opts: { tenantId: string }): Promise<IdentityInfo>;
  getIdentity(domain: string): Promise<IdentityInfo | null>;
  deleteIdentity(domain: string): Promise<void>;
}

export type MailerErrorCode = "EMAIL_DISABLED" | "NOT_CONFIGURED" | "PROVIDER_REJECTED" | "PROVIDER_UNAVAILABLE";

export class MailerError extends Error {
  constructor(
    public readonly code: MailerErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly awsName?: string
  ) {
    super(message);
    this.name = "MailerError";
  }
}

const RETRYABLE_NAMES = new Set(["ThrottlingException", "TooManyRequestsException", "TimeoutError", "AbortError"]);

const tagValue = (v: string): string => v.replace(/[^A-Za-z0-9_\-.@]/g, "_").slice(0, 256);
const oneLine = (v: string): string => v.replace(/[\r\n]+/g, " ");
const encodeWord = (v: string): string => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);
const wrap76 = (b64: string): string => b64.replace(/(.{76})/g, "$1\r\n");
const b64Part = (data: string | Buffer): string => wrap76(Buffer.from(data).toString("base64"));

export function mapIdentityStatus(dkimStatus: string | undefined, verified: boolean | undefined): IdentityStatus {
  if (dkimStatus === "SUCCESS" && verified) return "VERIFIED";
  if (dkimStatus === "FAILED") return "FAILED";
  return "PENDING";
}

export function buildDkimRecords(domain: string, tokens: string[] | undefined): DkimRecord[] {
  return (tokens ?? []).map((t) => ({ type: "CNAME" as const, name: `${t}._domainkey.${domain}`, value: `${t}.dkim.amazonses.com` }));
}

/** multipart/mixed( multipart/alternative(text, html), attachments... ), CRLF line endings, header values sanitised. */
export function buildRawMime(email: OutboundEmail, boundary = `rf_${randomBytes(12).toString("hex")}`): string {
  const alt = `${boundary}_alt`;
  const lines: string[] = [
    `From: ${oneLine(email.from)}`,
    `To: ${oneLine(email.to)}`,
    ...(email.replyTo ? [`Reply-To: ${oneLine(email.replyTo)}`] : []),
    `Subject: ${encodeWord(oneLine(email.subject))}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64Part(email.text),
    `--${alt}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64Part(email.html),
    `--${alt}--`,
  ];
  for (const a of email.attachments ?? []) {
    const name = a.filename.replace(/[^\w. -]+/g, "_");
    lines.push(
      `--${boundary}`,
      `Content-Type: ${oneLine(a.contentType)}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      b64Part(a.content)
    );
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

interface Deps {
  client?: Pick<SESv2Client, "send">;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAY_MS = 500;

export class SesMailer implements MailProvider {
  private readonly client?: Pick<SESv2Client, "send">;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly cfg: MailerConfig, deps: Deps = {}) {
    this.client = deps.client ?? (cfg.region ? new SESv2Client({ region: cfg.region, credentials: cfg.credentials }) : undefined);
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private ready(): Pick<SESv2Client, "send"> {
    if (this.cfg.disabled) throw new MailerError("EMAIL_DISABLED", "Email sending is switched off (EMAIL_DISABLED)");
    if (!this.cfg.region || !this.client) throw new MailerError("NOT_CONFIGURED", "Amazon SES is not configured (SES_REGION)");
    return this.client;
  }

  // One attempt plus one retry for throttling / 5xx / timeouts. `label` is log context only (never the recipient).
  private async call<T>(command: unknown, label: string): Promise<T> {
    const client = this.ready();
    for (let attempt = 0; ; attempt++) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (await client.send(command as any, { abortSignal: outboundSignal() })) as T;
      } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        const status = e.$metadata?.httpStatusCode;
        const retryable = (e.name !== undefined && RETRYABLE_NAMES.has(e.name)) || (status !== undefined && status >= 500);
        if (retryable && attempt === 0) {
          await this.sleep(RETRY_DELAY_MS);
          continue;
        }
        console.error(`[mailer] ${label} failed: aws=${e.name ?? "unknown"} status=${status ?? "-"} attempts=${attempt + 1}`);
        throw new MailerError(
          retryable ? "PROVIDER_UNAVAILABLE" : "PROVIDER_REJECTED",
          `Amazon SES ${retryable ? "is unavailable" : "rejected the request"} (${e.name ?? "unknown"})`,
          retryable,
          e.name
        );
      }
    }
  }

  async send(email: OutboundEmail): Promise<{ messageId: string }> {
    const tags = Object.entries(email.tags ?? {}).map(([Name, v]) => ({ Name, Value: tagValue(v) }));
    const subject = oneLine(email.subject);
    const content = email.attachments?.length
      ? { Raw: { Data: Buffer.from(buildRawMime({ ...email, subject })) } }
      : {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: { Html: { Data: email.html, Charset: "UTF-8" }, Text: { Data: email.text, Charset: "UTF-8" } },
          },
        };
    const command = new SendEmailCommand({
      FromEmailAddress: email.from,
      Destination: { ToAddresses: [email.to] },
      ...(email.replyTo ? { ReplyToAddresses: [email.replyTo] } : {}),
      ...(this.cfg.configurationSet ? { ConfigurationSetName: this.cfg.configurationSet } : {}),
      ...(tags.length ? { EmailTags: tags } : {}),
      Content: content,
    });
    const res = await this.call<{ MessageId?: string }>(command, `send tenant=${email.tags?.tenantId ?? "-"} message=${email.tags?.messageId ?? "-"}`);
    if (!res.MessageId) throw new MailerError("PROVIDER_REJECTED", "Amazon SES did not return a message id");
    return { messageId: res.MessageId };
  }

  async createIdentity(domain: string, opts: { tenantId: string }): Promise<IdentityInfo> {
    const command = new CreateEmailIdentityCommand({
      EmailIdentity: domain,
      DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
      ...(this.cfg.configurationSet ? { ConfigurationSetName: this.cfg.configurationSet } : {}),
      Tags: [{ Key: "tenantId", Value: tagValue(opts.tenantId) }],
    });
    try {
      const res = await this.call<{ DkimAttributes?: { Tokens?: string[]; Status?: string }; VerifiedForSendingStatus?: boolean }>(command, "createIdentity");
      return { status: mapIdentityStatus(res.DkimAttributes?.Status, res.VerifiedForSendingStatus), records: buildDkimRecords(domain, res.DkimAttributes?.Tokens) };
    } catch (err) {
      if (err instanceof MailerError && err.awsName === "AlreadyExistsException") {
        // The identity is account-wide in SES: only its registrant (the `tenantId` tag) may adopt it, otherwise one
        // tenant could claim, and send as, a domain another tenant already verified.
        const existing = await this.getIdentity(domain);
        if (existing?.ownerTenantId === tagValue(opts.tenantId)) return existing;
        throw new MailerError("PROVIDER_REJECTED", "This domain is already registered by another account", false, "AlreadyExistsException");
      }
      throw err;
    }
  }

  async getIdentity(domain: string): Promise<IdentityInfo | null> {
    try {
      const res = await this.call<{ DkimAttributes?: { Tokens?: string[]; Status?: string }; VerifiedForSendingStatus?: boolean; Tags?: Array<{ Key?: string; Value?: string }> }>(
        new GetEmailIdentityCommand({ EmailIdentity: domain }),
        "getIdentity"
      );
      const owner = res.Tags?.find((t) => t.Key === "tenantId")?.Value;
      return {
        status: mapIdentityStatus(res.DkimAttributes?.Status, res.VerifiedForSendingStatus),
        records: buildDkimRecords(domain, res.DkimAttributes?.Tokens),
        ...(owner ? { ownerTenantId: owner } : {}),
      };
    } catch (err) {
      if (err instanceof MailerError && err.awsName === "NotFoundException") return null;
      throw err;
    }
  }

  async deleteIdentity(domain: string): Promise<void> {
    try {
      await this.call(new DeleteEmailIdentityCommand({ EmailIdentity: domain }), "deleteIdentity");
    } catch (err) {
      if (err instanceof MailerError && err.awsName === "NotFoundException") return;
      throw err;
    }
  }
}
