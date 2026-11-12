import { describe, expect, it } from "vitest";
import { AnswerStreamParser, MAX_ELEMENT_CHARS, type ParsedElement } from "../stream-parser";

const ANSWER =
  "chatter before <intro>Here is October.</intro>\nfree chat <block>{\"type\":\"cards\",\"items\":[]}</block> x < y " +
  "<insight>Liam had the most skips (14).</insight><follow_up>Compare with September</follow_up> trailing";

const EXPECTED: ParsedElement[] = [
  { kind: "intro", text: "Here is October." },
  { kind: "block", text: '{"type":"cards","items":[]}' },
  { kind: "insight", text: "Liam had the most skips (14)." },
  { kind: "follow_up", text: "Compare with September" },
];

function parseChunks(chunks: string[]) {
  const p = new AnswerStreamParser();
  const out: ParsedElement[] = [];
  for (const c of chunks) out.push(...p.push(c));
  out.push(...p.end());
  return { out, p };
}

describe("AnswerStreamParser", () => {
  it("parses the whole answer in one chunk and discards text outside tags", () => {
    expect(parseChunks([ANSWER]).out).toEqual(EXPECTED);
  });

  it("gives the same result when the stream is split at EVERY byte boundary", () => {
    for (let i = 0; i <= ANSWER.length; i++) {
      expect(parseChunks([ANSWER.slice(0, i), ANSWER.slice(i)]).out).toEqual(EXPECTED);
    }
  });

  it("gives the same result for two split points and one char at a time", () => {
    for (let i = 0; i < ANSWER.length; i += 3) {
      for (let j = i; j < ANSWER.length; j += 7) {
        expect(parseChunks([ANSWER.slice(0, i), ANSWER.slice(i, j), ANSWER.slice(j)]).out).toEqual(EXPECTED);
      }
    }
    expect(parseChunks([...ANSWER]).out).toEqual(EXPECTED);
  });

  it("emits an element only once its closing tag has arrived", () => {
    const p = new AnswerStreamParser();
    expect(p.push("<intro>Hello </intro")).toEqual([]);
    expect(p.push(">")).toEqual([{ kind: "intro", text: "Hello " }]);
  });

  it("drops text and stray tags that are not part of the grammar, and ignores case differences", () => {
    const { out } = parseChunks(["<b>bold</b><INTRO>Loud</INTRO><introx>no</introx><intro>ok</intro><"]);
    expect(out).toEqual([{ kind: "intro", text: "ok" }]);
  });

  it("treats a tag nested inside an element as plain content (the lint rejects it later) and handles repeats", () => {
    const { out } = parseChunks(["<intro>a <insight>b</insight> c</intro><intro>two</intro><intro>three</intro>"]);
    expect(out).toEqual([
      { kind: "intro", text: "a <insight>b</insight> c" },
      { kind: "intro", text: "two" },
      { kind: "intro", text: "three" },
    ]);
  });

  it("keeps malformed JSON inside a block as raw text for the builder to reject", () => {
    expect(parseChunks(["<block>{oops</block>"]).out).toEqual([{ kind: "block", text: "{oops" }]);
  });

  it("discards an element that never closes and counts it as dropped", () => {
    const { out, p } = parseChunks(["<intro>Hello there", " and more"]);
    expect(out).toEqual([]);
    expect(p.dropped).toBe(1);
    const clean = parseChunks(["<intro>done</intro>"]);
    expect(clean.p.dropped).toBe(0);
  });

  it("discards an incomplete opening tag at the end of the stream without counting it", () => {
    const { out, p } = parseChunks(["<intro>ok</intro><insi"]);
    expect(out).toEqual([{ kind: "intro", text: "ok" }]);
    expect(p.dropped).toBe(0);
  });

  it("drops an oversize element whole, even when it is delivered in small chunks, and carries on", () => {
    const big = "x".repeat(MAX_ELEMENT_CHARS.follow_up + 10);
    const chunks = ["<follow_up>", big.slice(0, 100), big.slice(100), "</follow_up>", "<intro>fine</intro>"];
    const { out, p } = parseChunks(chunks);
    expect(out).toEqual([{ kind: "intro", text: "fine" }]);
    expect(p.dropped).toBe(1);
  });

  it("an oversize element that is still open when more text arrives keeps ignoring content", () => {
    const p = new AnswerStreamParser();
    p.push("<insight>" + "y".repeat(MAX_ELEMENT_CHARS.insight + 1));
    expect(p.push("more more more")).toEqual([]);
    expect(p.push("</insight>")).toEqual([]);
    expect(p.dropped).toBe(1);
  });
});
