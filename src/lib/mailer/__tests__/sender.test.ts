import { describe, expect, it } from "vitest";
import {
  buildFromHeader, isFreeMailDomain, resolveSender, sanitiseDisplayName, validateEmailAddress, validateLocalPart,
  validateSenderDomain, validateSenderName,
} from "../sender";
import { AppError } from "../../app-error";

const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return (e as AppError).code; }
  return undefined;
};

describe("validateSenderName", () => {
  it("accepts ordinary business names and trims", () => {
    expect(validateSenderName("  Sparkle Windows Ltd ")).toBe("Sparkle Windows Ltd");
    expect(validateSenderName("O'Brien & Sons (UK)")).toBe("O'Brien & Sons (UK)");
  });
  it.each([
    ["line break", "Evil\r\nBcc: x@y.com"],
    ["lf", "a\nb"],
    ["quote", 'A "B"'],
    ["angle", "A <b>"],
    ["gt", "A>"],
    ["control", "A\u0007"],
    ["too long", "x".repeat(71)],
    ["empty", "   "],
    ["at sign", "support@paypal.com"],
    ["semicolon", "A;B"],
  ])("rejects %s", (_n, v) => {
    expect(code(() => validateSenderName(v))).toBe("INVALID_EMAIL_SENDER_NAME");
  });
  it("rejects non-strings", () => {
    expect(code(() => validateSenderName(5 as never))).toBe("INVALID_EMAIL_SENDER_NAME");
  });
});

describe("sanitiseDisplayName (for existing business names)", () => {
  it("strips what a header cannot carry instead of throwing", () => {
    expect(sanitiseDisplayName('Bad "Name" <x>\r\nBcc: z')).toBe("Bad Name x Bcc z");
    expect(sanitiseDisplayName("a@b")).toBe("a b");
    expect(sanitiseDisplayName("x".repeat(100))).toHaveLength(70);
    expect(sanitiseDisplayName(null)).toBe("");
    expect(sanitiseDisplayName("   ")).toBe("");
  });
});

describe("validateEmailAddress (reply-to)", () => {
  it("accepts and lower-cases a normal address", () => {
    expect(validateEmailAddress(" Owner@Example.co.uk ", "emailReplyTo")).toBe("owner@example.co.uk");
  });
  it.each(["a@b", "a b@c.com", "a@b.com\r\nBcc: x@y.com", "<a@b.com>", '"a"@b.com', "a@b.com,c@d.com", "a@@b.com", "", "x".repeat(250) + "@a.com", "a@-b.com"])(
    "rejects %j",
    (v) => expect(code(() => validateEmailAddress(v, "emailReplyTo"))).toBe("INVALID_EMAIL_ADDRESS")
  );
  it("rejects non-strings", () => {
    expect(code(() => validateEmailAddress(7 as never, "emailReplyTo"))).toBe("INVALID_EMAIL_ADDRESS");
  });
});

describe("validateLocalPart", () => {
  it("accepts simple local parts", () => {
    expect(validateLocalPart("Accounts")).toBe("accounts");
    expect(validateLocalPart("no-reply.team_1")).toBe("no-reply.team_1");
  });
  it.each(["", "a b", "a@b", "-a", "a..b", ".a", "a.", "x".repeat(65), "a\r\nb", "a<b>"])("rejects %j", (v) => {
    expect(code(() => validateLocalPart(v))).toBe("INVALID_EMAIL_LOCAL_PART");
  });
  it("rejects non-strings", () => {
    expect(code(() => validateLocalPart(1 as never))).toBe("INVALID_EMAIL_LOCAL_PART");
  });
});

describe("validateSenderDomain", () => {
  const shared = "mail.roundflow.ai";
  it("accepts and lower-cases an own domain", () => {
    expect(validateSenderDomain(" Sparkle-Windows.co.uk ", shared)).toBe("sparkle-windows.co.uk");
  });
  it.each(["gmail.com", "googlemail.com", "outlook.com", "hotmail.co.uk", "yahoo.co.uk", "icloud.com", "live.com", "aol.com", "proton.me", "protonmail.com", "me.com", "msn.com", "gmx.com", "btinternet.com"])(
    "refuses free-mail %s",
    (d) => expect(code(() => validateSenderDomain(d, shared))).toBe("FREE_MAIL_DOMAIN")
  );
  it("refuses the platform sending domain and its parents/children (spoofing)", () => {
    for (const d of ["mail.roundflow.ai", "x.mail.roundflow.ai", "roundflow.ai", "amazonses.com", "supabase.co"]) {
      expect(code(() => validateSenderDomain(d, shared))).toBe("RESERVED_EMAIL_DOMAIN");
    }
  });
  it.each(["", "localhost", "a_b.com", "-a.com", "a.com.", "http://a.com", "a.com/x", "a b.com", "a..com", "a.c", "1.2.3.4", "x".repeat(64) + ".com", "ünï.com"])("rejects malformed %j", (d) => {
    expect(code(() => validateSenderDomain(d, shared))).toBe("INVALID_EMAIL_DOMAIN");
  });
  it("rejects non-strings", () => {
    expect(code(() => validateSenderDomain(3 as never, shared))).toBe("INVALID_EMAIL_DOMAIN");
  });
  it("works without a configured shared domain", () => {
    expect(validateSenderDomain("a-b.com", null)).toBe("a-b.com");
  });
  it("isFreeMailDomain also matches subdomains of free-mail providers", () => {
    expect(isFreeMailDomain("mail.yahoo.com")).toBe(true);
    expect(isFreeMailDomain("yahooish.com")).toBe(false);
  });
});

describe("buildFromHeader", () => {
  it("quotes the display name", () => {
    expect(buildFromHeader("Sparkle Windows", "n@mail.roundflow.ai")).toBe('"Sparkle Windows" <n@mail.roundflow.ai>');
  });
  it("RFC 2047 encodes non-ASCII names", () => {
    expect(buildFromHeader("Café Clean", "n@x.co")).toBe(`"=?UTF-8?B?${Buffer.from("Café Clean").toString("base64")}?=" <n@x.co>`);
  });
  it("falls back to the bare address when there is no name", () => {
    expect(buildFromHeader("", "n@x.co")).toBe("n@x.co");
  });
});

describe("resolveSender", () => {
  const base = {
    businessName: "Sparkle Windows", email: "owner@sparkle.co.uk", emailSenderName: null, emailReplyTo: null,
    emailSenderDomain: null, emailSenderLocalPart: null, emailDomainStatus: "NONE",
  } as const;
  const shared = "notifications@mail.roundflow.ai";

  it("tier 1: business name on the shared address, reply-to = business email", () => {
    expect(resolveSender(base, shared)).toEqual({
      tier: 1, from: '"Sparkle Windows" <notifications@mail.roundflow.ai>', replyTo: "owner@sparkle.co.uk", fromAddress: shared, displayName: "Sparkle Windows",
    });
  });
  it("uses emailSenderName and emailReplyTo when set", () => {
    const r = resolveSender({ ...base, emailSenderName: "Sparkle Accounts", emailReplyTo: "accounts@sparkle.co.uk" }, shared);
    expect(r.from).toBe('"Sparkle Accounts" <notifications@mail.roundflow.ai>');
    expect(r.replyTo).toBe("accounts@sparkle.co.uk");
  });
  it("falls back to the shared address while the domain is not VERIFIED", () => {
    for (const status of ["NONE", "PENDING", "FAILED"]) {
      const r = resolveSender({ ...base, emailSenderDomain: "sparkle.co.uk", emailDomainStatus: status }, shared);
      expect(r.tier).toBe(1);
      expect(r.from).toContain("notifications@mail.roundflow.ai");
    }
  });
  it("tier 2: sends from the tenant domain once VERIFIED (default local part accounts)", () => {
    const r = resolveSender({ ...base, emailSenderDomain: "sparkle.co.uk", emailDomainStatus: "VERIFIED" }, shared);
    expect(r).toMatchObject({ tier: 2, fromAddress: "accounts@sparkle.co.uk", from: '"Sparkle Windows" <accounts@sparkle.co.uk>' });
    const custom = resolveSender({ ...base, emailSenderDomain: "sparkle.co.uk", emailDomainStatus: "VERIFIED", emailSenderLocalPart: "billing" }, shared);
    expect(custom.fromAddress).toBe("billing@sparkle.co.uk");
  });
  it("uses a neutral display name and no reply-to when the tenant has neither", () => {
    const r = resolveSender({ ...base, businessName: null, email: null }, shared);
    expect(r.displayName).toBe("");
    expect(r.from).toBe("notifications@mail.roundflow.ai");
    expect(r.replyTo).toBeUndefined();
  });
  it("ignores a stored business email / reply-to that is not a valid address", () => {
    expect(resolveSender({ ...base, email: "not-an-email" }, shared).replyTo).toBeUndefined();
    expect(resolveSender({ ...base, emailReplyTo: "bad", email: "owner@sparkle.co.uk" }, shared).replyTo).toBe("owner@sparkle.co.uk");
  });
  it("sanitises a business name containing header-breaking characters", () => {
    const r = resolveSender({ ...base, businessName: 'Bad\r\nBcc: x@y.com "Co"' }, shared);
    expect(r.from).not.toMatch(/[\r\n]/);
    expect(r.from.match(/"/g)).toHaveLength(2);
  });
});
