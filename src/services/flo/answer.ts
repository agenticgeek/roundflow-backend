import { createFigureChecker } from "./figure-check";
import { lintProse, PROSE_LIMITS } from "./prose-lint";
import type { ParsedElement } from "./stream-parser";
import { LINK_SCREENS } from "./system-prompt";
import type { CellValue, ColumnFormat, DeclineCopy, Mode, ModeConfig, ResultColumn, ToolDateRange, ToolResult } from "./types";

// The answer contract (plan 4.1 / 3.6) and the block builders. THE MODEL NEVER SUPPLIES A VALUE: it names a sourceId, a
// path or column keys and a title; every figure, format, row and total is read from the stored tool result here (D4).
// The types in this file are the wire types (final message, blocks, SSE events) copied into the frontend contract doc.

// ---- contract types ------------------------------------------------------------------------------------------------

export type LinkScreen = (typeof LINK_SCREENS)[number];

export interface FloLink {
  screen: LinkScreen;
  params?: Record<string, string>;
}

export type AnswerCell = string | number | null;
export type CardTone = "neutral" | "positive" | "negative" | "warning";

export interface CardItem {
  label: string;
  value: AnswerCell;
  format: ColumnFormat;
  sub?: string;
  tone?: CardTone;
}

export interface CardsBlock {
  type: "cards";
  items: CardItem[];
  link?: FloLink;
}

export interface TableBlock {
  type: "table";
  title: string;
  sourceId: string;
  columns: ResultColumn[];
  rows: Array<Record<string, AnswerCell>>;
  totals?: Record<string, AnswerCell>;
  link?: FloLink;
}

export type AnswerBlock = CardsBlock | TableBlock;

export interface AnswerInsight {
  text: string;
  unverified: boolean;
  link?: FloLink;
}

export interface AnswerSource {
  id: string;
  tool: string;
  label: string;
  rows: number;
}

export interface FinalAnswer {
  intro: string;
  /** True when an intro sentence failed the figure check (the insights carry their own flag). */
  introUnverified: boolean;
  dateRange?: ToolDateRange;
  blocks: AnswerBlock[];
  insights: AnswerInsight[];
  followUps: string[];
  sources: AnswerSource[];
  truncated: boolean;
}

export type MessageStatus = "OK" | "ERROR" | "DECLINED" | "ABORTED";

export interface FinalMessage {
  id: string;
  role: "ASSISTANT";
  mode: Mode | null;
  model: string | null;
  status: MessageStatus;
  createdAt: string;
  declined: DeclineCopy | null;
  answer: FinalAnswer | null;
  warnings: string[];
  errorCode?: string;
}

export interface UserMessage {
  id: string;
  role: "USER";
  text: string;
  createdAt: string;
}

export type FloErrorCode = "FLO_PROVIDER_ERROR" | "FLO_TIMEOUT" | "FLO_NO_ANSWER" | "FLO_INTERNAL_ERROR";

/** Every SSE event, in the shape written to the wire (`event:` = `event`, one JSON `data:` line = `data`). */
export type FloEvent =
  | { event: "start"; data: { conversationId: string; messageId: string; mode: Mode } }
  | { event: "status"; data: { phase: "checking" | "checked"; tool: string; label: string; rows?: number } }
  | { event: "block"; data: { index: number; block: AnswerBlock } }
  | { event: "text"; data: { target: "intro" | "insight"; index: number; text: string; unverified?: true } }
  | { event: "follow_ups"; data: { items: string[] } }
  | { event: "declined"; data: { reason: string; text: string; suggestions: string[] } }
  | { event: "warning"; data: { code: "UNVERIFIED_FIGURES" } }
  | { event: "done"; data: { message: FinalMessage } }
  | { event: "error"; data: { code: string; message: string; retryable: boolean } };

// ---- helpers -------------------------------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

const ABBREVIATION = /\b(?:mr|mrs|ms|dr|st|no|vs|approx|e\.g|i\.e)\.$/i;

/** Splits prose into sentences. "Mrs. Smith" and decimals such as 96.4% do not split. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of text.matchAll(/[.!?]+(?=\s+\S)/g)) {
    const end = (m.index as number) + m[0].length;
    if (ABBREVIATION.test(text.slice(start, end))) continue;
    out.push(text.slice(start, end).trim());
    start = end;
  }
  out.push(text.slice(start).trim());
  return out.filter((s) => s !== "");
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_PERIODS = ["thisWeek", "lastWeek", "thisMonth", "lastMonth", "last7", "last30", "last90"];

/** Which deep-link params each screen accepts (the frontend reads roundId, date and visitId; REPORTS takes a period). */
const LINK_PARAMS: Record<LinkScreen, Record<string, "id" | "date" | "period">> = {
  TODAYS_WORK: { date: "date", visitId: "id" },
  ROUND: { roundId: "id", date: "date" },
  CUSTOMERS: {},
  DEBT_PAYMENT: {},
  REPORTS: { period: "period" },
  COMPLAINTS: {},
  TECHNICIANS: {},
  INVOICES: {},
};

/** A link from the closed `screen` enum with validated params, or undefined. Id params must be ids seen in this chat. */
export function buildLink(raw: unknown, isKnownId: (id: string) => boolean): FloLink | undefined {
  if (!isRecord(raw) || !(LINK_SCREENS as readonly unknown[]).includes(raw.screen)) return undefined;
  const screen = raw.screen as LinkScreen;
  const rules = LINK_PARAMS[screen];
  const params: Record<string, string> = {};
  for (const [key, value] of isRecord(raw.params) ? Object.entries(raw.params) : []) {
    if (!own(rules, key) || typeof value !== "string") continue;
    const rule = rules[key];
    const valid = rule === "date" ? DATE_RE.test(value) : rule === "period" ? REPORT_PERIODS.includes(value) : ID_RE.test(value) && isKnownId(value);
    if (valid) params[key] = value;
  }
  return Object.keys(params).length > 0 ? { screen, params } : { screen };
}

const cell = (v: CellValue | undefined): AnswerCell => (typeof v === "boolean" ? (v ? "Yes" : "No") : (v ?? null));

function project(row: Record<string, CellValue>, keys: string[]): Record<string, AnswerCell> {
  return Object.fromEntries(keys.map((k) => [k, cell(row[k])]));
}

// ---- block builders ------------------------------------------------------------------------------------------------

export type BlockRejection = "INVALID" | "UNKNOWN_SOURCE" | "UNKNOWN_COLUMN" | "UNKNOWN_PATH" | "EMPTY";

export type BuildOutcome = { ok: true; block: AnswerBlock } | { ok: false; reason: BlockRejection };

export interface BuildContext {
  results: ReadonlyMap<string, ToolResult>;
  isKnownId: (id: string) => boolean;
  /** True when every figure in `text` is grounded in the stored results. */
  figuresOk: (text: string) => boolean;
}

const MAX_CARD_ITEMS = 6;
const MAX_TABLE_COLUMNS = 8;
const MAX_LABEL = 40;
const TONES: readonly string[] = ["neutral", "positive", "negative", "warning"];
const PATH_RE = /^(?:totals|rows\.\d{1,3})\.[A-Za-z_][A-Za-z0-9_]*$/;

function readPath(result: ToolResult, path: string): CellValue | undefined {
  const parts = path.split(".");
  const key = parts[parts.length - 1];
  const holder = parts[0] === "totals" ? result.totals : result.rows[Number(parts[1])];
  return holder && own(holder, key) ? holder[key] : undefined;
}

function buildCardItem(raw: unknown, ctx: BuildContext): CardItem | null {
  if (!isRecord(raw) || typeof raw.label !== "string" || typeof raw.sourceId !== "string" || typeof raw.path !== "string") return null;
  const result = ctx.results.get(raw.sourceId);
  const label = lintProse(raw.label, "follow_up");
  if (!result || !label.ok || label.text.length > MAX_LABEL || !PATH_RE.test(raw.path)) return null;
  const value = readPath(result, raw.path);
  if (typeof value !== "number" && typeof value !== "string") return null;
  const key = raw.path.slice(raw.path.lastIndexOf(".") + 1);
  const column = result.columns.find((c) => c.key === key);
  const item: CardItem = { label: label.text, value, format: column?.format ?? (Number.isInteger(value) ? "integer" : "text") };
  const sub = typeof raw.sub === "string" ? lintProse(raw.sub, "follow_up") : null;
  if (sub?.ok && ctx.figuresOk(sub.text)) item.sub = sub.text;
  if (typeof raw.tone === "string" && TONES.includes(raw.tone)) item.tone = raw.tone as CardTone;
  return item;
}

function buildCards(raw: Record<string, unknown>, ctx: BuildContext): BuildOutcome {
  const rawItems = Array.isArray(raw.items) ? raw.items.slice(0, MAX_CARD_ITEMS) : [];
  const items = rawItems.map((i) => buildCardItem(i, ctx)).filter((i): i is CardItem => i !== null);
  if (items.length === 0) return { ok: false, reason: "INVALID" };
  const block: CardsBlock = { type: "cards", items };
  const link = buildLink(raw.link, ctx.isKnownId);
  if (link) block.link = link;
  return { ok: true, block };
}

function buildTable(raw: Record<string, unknown>, ctx: BuildContext): BuildOutcome {
  const result = typeof raw.sourceId === "string" ? ctx.results.get(raw.sourceId) : undefined;
  if (!result) return { ok: false, reason: "UNKNOWN_SOURCE" };
  const keys = Array.isArray(raw.columns) && raw.columns.every((k) => typeof k === "string") ? (raw.columns as string[]) : [];
  if (keys.length === 0 || keys.length > MAX_TABLE_COLUMNS || new Set(keys).size !== keys.length) return { ok: false, reason: "INVALID" };
  const columns = keys.map((k) => result.columns.find((c) => c.key === k));
  if (columns.some((c) => !c)) return { ok: false, reason: "UNKNOWN_COLUMN" };
  if (result.rows.length === 0) return { ok: false, reason: "EMPTY" };
  const title = typeof raw.title === "string" ? lintProse(raw.title, "follow_up") : null;
  const block: TableBlock = {
    type: "table",
    title: title?.ok ? title.text : result.label,
    sourceId: result.sourceId,
    columns: columns as ResultColumn[],
    rows: result.rows.map((r) => project(r, keys)),
  };
  if (result.totals) block.totals = project(result.totals, keys);
  const link = buildLink(raw.link, ctx.isKnownId);
  if (link) block.link = link;
  return { ok: true, block };
}

/** Validates a `<block>` JSON object and builds the block from stored results. Never trusts a model-supplied value. */
export function buildBlock(raw: unknown, ctx: BuildContext): BuildOutcome {
  if (!isRecord(raw)) return { ok: false, reason: "INVALID" };
  if (raw.type === "cards") return buildCards(raw, ctx);
  if (raw.type === "table") return buildTable(raw, ctx);
  return { ok: false, reason: "INVALID" };
}

// ---- the builder that turns parsed elements into events and the final answer ---------------------------------------------

const MAX_FOLLOW_UPS = 3;

export interface AnswerBuilderDeps {
  /** The live store of tool results (owned by the orchestrator; successful results only). */
  results: ReadonlyMap<string, ToolResult>;
  /** Ids passed to tools as validated arguments in this chat (a link may point at them). */
  knownIds: ReadonlySet<string>;
}

interface Prose {
  text: string;
  unverified: boolean;
}

export class AnswerBuilder {
  private intro: Prose[] = [];
  private insights: Prose[] = [];
  private blocks: AnswerBlock[] = [];
  private followUps: string[] = [];
  private tables = 0;
  private cards = 0;
  private checker: ((s: string) => { ok: boolean }) | null = null;
  private checkerSize = -1;
  /** Elements rejected by lint, validation or mode limits (audit only). */
  rejected = 0;

  constructor(
    private readonly mode: ModeConfig,
    private readonly deps: AnswerBuilderDeps
  ) {}

  hasContent(): boolean {
    return this.intro.length + this.insights.length + this.blocks.length > 0;
  }

  private figuresOk = (text: string): boolean => {
    if (this.checker === null || this.checkerSize !== this.deps.results.size) {
      this.checker = createFigureChecker(this.deps.results.values());
      this.checkerSize = this.deps.results.size;
    }
    return this.checker(text).ok;
  };

  private isKnownId = (id: string): boolean =>
    this.deps.knownIds.has(id) || [...this.deps.results.values()].some((r) => r.rows.some((row) => Object.values(row).includes(id)));

  /** Validates one parsed element; returns the events to send now (block / text). Rejected elements return nothing. */
  accept(el: ParsedElement): FloEvent[] {
    switch (el.kind) {
      case "block":
        return this.acceptBlock(el.text);
      case "intro":
        return this.acceptProse("intro", el.text);
      case "insight":
        return this.acceptProse("insight", el.text);
      case "follow_up":
        this.acceptFollowUp(el.text);
        return [];
    }
  }

  private acceptBlock(json: string): FloEvent[] {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      this.rejected++;
      return [];
    }
    const type = isRecord(raw) ? raw.type : undefined;
    const withinLimit = type === "table" ? this.tables < this.mode.maxTables : type === "cards" ? this.cards < this.mode.maxCards : true;
    const built = withinLimit ? buildBlock(raw, { results: this.deps.results, isKnownId: this.isKnownId, figuresOk: this.figuresOk }) : null;
    if (!built || !built.ok) {
      this.rejected++;
      return [];
    }
    if (built.block.type === "table") this.tables++;
    else this.cards++;
    this.blocks.push(built.block);
    return [{ event: "block", data: { index: this.blocks.length - 1, block: built.block } }];
  }

  private acceptProse(target: "intro" | "insight", text: string): FloEvent[] {
    const list = target === "intro" ? this.intro : this.insights;
    const max = target === "intro" ? this.mode.maxIntroSentences : this.mode.maxInsights;
    const events: FloEvent[] = [];
    let chars = 0;
    for (const sentence of splitSentences(text)) {
      const lint = lintProse(sentence, target);
      chars += lint.ok ? lint.text.length : 0;
      if (list.length >= max || chars > PROSE_LIMITS[target]) break;
      if (!lint.ok) {
        this.rejected++;
        continue;
      }
      const unverified = !this.figuresOk(lint.text);
      list.push({ text: lint.text, unverified });
      events.push({ event: "text", data: { target, index: list.length - 1, text: lint.text, ...(unverified ? { unverified: true as const } : {}) } });
    }
    return events;
  }

  private acceptFollowUp(text: string): void {
    const lint = lintProse(text, "follow_up");
    if (!lint.ok || this.followUps.length >= MAX_FOLLOW_UPS || this.followUps.includes(lint.text)) {
      this.rejected++;
      return;
    }
    this.followUps.push(lint.text);
  }

  /** The closing events (follow_ups, warning) and the final answer. Call once, after the last element. */
  finish(): { events: FloEvent[]; answer: FinalAnswer; warnings: string[] } {
    const results = [...this.deps.results.values()];
    const unverified = this.intro.some((p) => p.unverified) || this.insights.some((p) => p.unverified);
    const warnings = unverified ? ["UNVERIFIED_FIGURES"] : [];
    const events: FloEvent[] = [];
    if (this.followUps.length > 0) events.push({ event: "follow_ups", data: { items: [...this.followUps] } });
    if (unverified) events.push({ event: "warning", data: { code: "UNVERIFIED_FIGURES" } });
    const cited = this.blocks.flatMap((b) => (b.type === "table" ? [this.deps.results.get(b.sourceId)] : []));
    const dateRange = [...cited, ...results].find((r) => r?.dateRange)?.dateRange ?? undefined;
    const answer: FinalAnswer = {
      intro: this.intro.map((p) => p.text).join(" "),
      introUnverified: this.intro.some((p) => p.unverified),
      ...(dateRange ? { dateRange } : {}),
      blocks: this.blocks,
      insights: this.insights.map((p) => ({ text: p.text, unverified: p.unverified })),
      followUps: [...this.followUps],
      sources: results.map((r) => ({ id: r.sourceId, tool: r.tool, label: r.label, rows: r.rows.length })),
      truncated: results.some((r) => r.truncated),
    };
    return { events, answer, warnings };
  }
}

/** The plain text stored on the assistant row and replayed as history: the intro and insights only. */
export function answerText(answer: FinalAnswer): string {
  return [answer.intro, ...answer.insights.map((i) => i.text)].filter((s) => s !== "").join(" ");
}
