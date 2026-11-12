import { describe, expect, it } from "vitest";
import { isMailerConfigured, mailerConfig, sharedSendingDomain } from "../config";

describe("mailerConfig", () => {
  it("reads the SES_* variables and trims them", () => {
    const cfg = mailerConfig({
      SES_REGION: " eu-west-2 ", SES_FROM_DOMAIN_ADDRESS: "notifications@mail.roundflow.ai", SES_CONFIGURATION_SET: "rf-set",
      SES_ACCESS_KEY_ID: "AKIATEST", SES_SECRET_ACCESS_KEY: "secret",
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({
      region: "eu-west-2", fromAddress: "notifications@mail.roundflow.ai", configurationSet: "rf-set",
      credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" }, disabled: false,
    });
  });
  it("omits credentials unless both halves are set (default AWS credential chain)", () => {
    expect(mailerConfig({ SES_ACCESS_KEY_ID: "x" } as NodeJS.ProcessEnv).credentials).toBeUndefined();
    expect(mailerConfig({} as NodeJS.ProcessEnv).region).toBeUndefined();
  });
  it("EMAIL_DISABLED=true disables", () => {
    expect(mailerConfig({ EMAIL_DISABLED: "true" } as NodeJS.ProcessEnv).disabled).toBe(true);
    expect(mailerConfig({ EMAIL_DISABLED: "false" } as NodeJS.ProcessEnv).disabled).toBe(false);
  });
});

describe("isMailerConfigured / sharedSendingDomain", () => {
  const ok = { SES_REGION: "eu-west-2", SES_FROM_DOMAIN_ADDRESS: "notifications@mail.roundflow.ai" } as NodeJS.ProcessEnv;
  it("needs region and from address, and not disabled", () => {
    expect(isMailerConfigured(ok)).toBe(true);
    expect(isMailerConfigured({ ...ok, EMAIL_DISABLED: "true" })).toBe(false);
    expect(isMailerConfigured({ SES_REGION: "eu-west-2" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isMailerConfigured({ SES_FROM_DOMAIN_ADDRESS: "a@b.co" } as NodeJS.ProcessEnv)).toBe(false);
  });
  it("derives the sending domain from the address", () => {
    expect(sharedSendingDomain(ok)).toBe("mail.roundflow.ai");
    expect(sharedSendingDomain({} as NodeJS.ProcessEnv)).toBeNull();
    expect(sharedSendingDomain({ SES_FROM_DOMAIN_ADDRESS: "nodomain" } as NodeJS.ProcessEnv)).toBeNull();
  });
});
