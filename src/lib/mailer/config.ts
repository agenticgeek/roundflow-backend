// Wave 2B-2 (GHL-03): SES configuration from the environment. Read at call time (not import time) so tests and
// deployments can change it without a restart-order problem.

export interface MailerConfig {
  region?: string;
  /** Shared sending address on the RoundFlow-owned, SES-verified subdomain, e.g. notifications@mail.roundflow.ai. */
  fromAddress?: string;
  /** SES configuration set that publishes Delivery/Bounce/Complaint events to SNS. */
  configurationSet?: string;
  /** Optional static credentials; unset = the default AWS credential chain (instance role, env, profile). */
  credentials?: { accessKeyId: string; secretAccessKey: string };
  disabled: boolean;
}

const clean = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

export function mailerConfig(env: NodeJS.ProcessEnv = process.env): MailerConfig {
  const accessKeyId = clean(env.SES_ACCESS_KEY_ID);
  const secretAccessKey = clean(env.SES_SECRET_ACCESS_KEY);
  return {
    region: clean(env.SES_REGION),
    fromAddress: clean(env.SES_FROM_DOMAIN_ADDRESS),
    configurationSet: clean(env.SES_CONFIGURATION_SET),
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    disabled: env.EMAIL_DISABLED === "true",
  };
}

/** True when RoundFlow can send email at all (SES configured and not switched off). */
export function isMailerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const cfg = mailerConfig(env);
  return !cfg.disabled && !!cfg.region && !!cfg.fromAddress;
}

/** Domain part of SES_FROM_DOMAIN_ADDRESS (the shared sending subdomain), or null. */
export function sharedSendingDomain(env: NodeJS.ProcessEnv = process.env): string | null {
  const addr = mailerConfig(env).fromAddress;
  const at = addr?.lastIndexOf("@") ?? -1;
  return addr && at >= 0 ? addr.slice(at + 1).toLowerCase() : null;
}
