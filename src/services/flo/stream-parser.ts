// Incremental parser for the main model's tagged final answer (plan 3.5). The grammar is closed:
//   <intro>..</intro>  <block>{json}</block>  <insight>..</insight>  <follow_up>..</follow_up>
// Anything outside these tags is discarded. Text arrives in arbitrary chunks, so a tag may be split at ANY byte
// boundary; the parser holds back a possible partial tag until it can decide. It never interprets the content: the
// answer builder lints, figure-checks and validates each completed element.

export type ElementKind = "intro" | "insight" | "follow_up" | "block";

export interface ParsedElement {
  kind: ElementKind;
  text: string;
}

const KINDS: readonly ElementKind[] = ["intro", "block", "insight", "follow_up"];
const OPEN_TAGS = KINDS.map((k) => `<${k}>`);

/** Oversize guard per element (characters of raw content). A longer element is dropped whole. */
export const MAX_ELEMENT_CHARS: Record<ElementKind, number> = { intro: 1200, insight: 800, follow_up: 300, block: 8000 };

/** Length of the longest proper prefix of `tag` that `buf` ends with (a partially received closing tag). */
function partialSuffixLength(buf: string, tag: string): number {
  for (let k = Math.min(buf.length, tag.length - 1); k > 0; k--) {
    if (buf.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

export class AnswerStreamParser {
  private buf = "";
  private open: ElementKind | null = null;
  private content = "";
  private overflow = false;
  /** Elements discarded for being oversize or unclosed at the end of the stream. */
  dropped = 0;

  push(chunk: string): ParsedElement[] {
    this.buf += chunk;
    return this.drain();
  }

  /** The stream is over: an element that never closed is discarded. */
  end(): ParsedElement[] {
    const out = this.drain();
    if (this.open !== null) this.dropped++;
    this.open = null;
    this.buf = "";
    this.content = "";
    return out;
  }

  private absorb(text: string): void {
    if (this.overflow) return;
    this.content += text;
    if (this.content.length > MAX_ELEMENT_CHARS[this.open as ElementKind]) {
      this.overflow = true;
      this.content = "";
    }
  }

  private drain(): ParsedElement[] {
    const out: ParsedElement[] = [];
    for (;;) {
      if (this.open === null) {
        const lt = this.buf.indexOf("<");
        if (lt === -1) {
          this.buf = "";
          return out;
        }
        this.buf = this.buf.slice(lt);
        const kind = KINDS.find((k) => this.buf.startsWith(`<${k}>`));
        if (kind) {
          this.open = kind;
          this.buf = this.buf.slice(kind.length + 2);
          this.content = "";
          this.overflow = false;
          continue;
        }
        if (OPEN_TAGS.some((t) => t.startsWith(this.buf))) return out; // might still become a tag: wait
        this.buf = this.buf.slice(1); // a stray "<" outside any tag
      } else {
        const close = `</${this.open}>`;
        const at = this.buf.indexOf(close);
        if (at === -1) {
          const keep = partialSuffixLength(this.buf, close);
          this.absorb(this.buf.slice(0, this.buf.length - keep));
          this.buf = this.buf.slice(this.buf.length - keep);
          return out;
        }
        this.absorb(this.buf.slice(0, at));
        this.buf = this.buf.slice(at + close.length);
        if (this.overflow) this.dropped++;
        else out.push({ kind: this.open, text: this.content });
        this.open = null;
      }
    }
  }
}
