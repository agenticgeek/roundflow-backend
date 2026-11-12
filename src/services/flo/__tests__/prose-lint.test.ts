import { describe, expect, it } from "vitest";
import { lintProse, PROSE_LIMITS } from "../prose-lint";

const reason = (t: string, kind: "intro" | "insight" | "follow_up" = "insight") => {
  const r = lintProse(t, kind);
  return r.ok ? "OK" : r.reason;
};

describe("lintProse", () => {
  it("passes normal sentences with money, percentages, dates and parentheses, and trims", () => {
    for (const s of [
      "Liam Walsh had the most skips (14).",
      "Revenue was £13,650.00, up 12.5% on September.",
      "Between 2026-10-01 - 2026-10-30 you completed 781 of 810 jobs.",
      "Round 7 is due on 12 Nov 2026 and is worth £1,240.",
      "Let me know if you want the let-go list (3 customers).",
    ]) {
      expect(reason(s)).toBe("OK");
    }
    expect(lintProse("  Hello there.  ", "intro")).toEqual({ ok: true, text: "Hello there." });
  });

  it("rejects empty text and over-length text per kind", () => {
    expect(reason("   ")).toBe("EMPTY");
    expect(reason("a".repeat(PROSE_LIMITS.insight + 1), "insight")).toBe("TOO_LONG");
    expect(reason("a".repeat(PROSE_LIMITS.insight), "insight")).toBe("OK");
    expect(reason("a".repeat(PROSE_LIMITS.intro + 1), "intro")).toBe("TOO_LONG");
    expect(reason("a".repeat(PROSE_LIMITS.follow_up + 1), "follow_up")).toBe("TOO_LONG");
    expect(PROSE_LIMITS).toEqual({ intro: 300, insight: 200, follow_up: 80 });
  });

  it("rejects URLs", () => {
    expect(reason("See https://evil.example/path for more")).toBe("URL");
    expect(reason("Go to http://x.io")).toBe("URL");
    expect(reason("Visit www.example for details")).toBe("URL");
    expect(reason("Open roundflow.com/admin now")).toBe("URL");
    expect(reason("ftp://files.local/a")).toBe("URL");
  });

  it("rejects markdown links and images", () => {
    expect(reason("Click [here](/admin)")).toBe("MARKDOWN_LINK");
    expect(reason("![x](a.png)")).toBe("MARKDOWN_LINK");
  });

  it("rejects code", () => {
    expect(reason("Use `rm -rf`")).toBe("CODE");
    expect(reason("```js\nx\n```")).toBe("CODE");
    expect(reason("{ \"a\": 1 }")).toBe("CODE");
    expect(reason("x => y")).toBe("CODE");
    expect(reason("Line one\n    indented code line")).toBe("CODE");
    expect(reason("~~~")).toBe("CODE");
  });

  it("rejects HTML tags and entities", () => {
    expect(reason("Hello <b>world</b>")).toBe("HTML");
    expect(reason("<script>x</script>")).toBe("HTML");
    expect(reason("a &amp; b")).toBe("HTML");
    expect(reason("a &#169; b")).toBe("HTML");
  });

  it("rejects email addresses", () => {
    expect(reason("Mail jo.smith@example.co.uk about it")).toBe("EMAIL");
  });

  it("rejects phone numbers but not ISO dates or plain figures", () => {
    expect(reason("Call 07123 456789 today")).toBe("PHONE");
    expect(reason("Call +44 7123 456789 today")).toBe("PHONE");
    expect(reason("Call 020 7946 0958 today")).toBe("PHONE");
    expect(reason("Id 12345678901 here")).toBe("PHONE");
    expect(reason("From 2026-01-05 to 2026-01-09")).toBe("OK");
  });

  it("rejects control and invisible characters", () => {
    expect(reason("Hi\u0007there")).toBe("CONTROL_CHARS");
    expect(reason("Hi​there")).toBe("CONTROL_CHARS");
    expect(reason("Hi‮there")).toBe("CONTROL_CHARS");
  });
});
