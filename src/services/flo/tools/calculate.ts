import type { ColumnFormat, ResultRow, ToolContext, ToolDefinition, ToolResult } from "../types";
import { columns, round2, ToolInputError } from "./shared";

// calculate(op, a, b?): fixed arithmetic over figures that earlier tool calls in THIS request already returned.
// No expression strings, no eval, no database access: the only inputs are references (sourceId + path) resolved against
// ToolContext.results. The result is a normal one-row table, so the answer pipeline treats it as data.
//
// Paths: totals.<key> | rows.<index>.<key> | column.<key> (every non-null value of that column).
// Operations:
//   sum            a (one or many refs) -> total of every value
//   average        a (one or many refs) -> mean of every value
//   difference     a - b                     (same kind of number)
//   percent_change (a - b) / b * 100         (a = new value, b = old/baseline value, same kind of number)
//   percent_of     a / b * 100               (a as a percentage of b)
//   ratio          a / b                     (e.g. revenue per job)
//   rank           position of b among the values of a (1 = highest)
// Division by zero returns value null plus a note row; it never throws.

const OPS = ["sum", "difference", "percent_change", "percent_of", "ratio", "average", "rank"] as const;
type Op = (typeof OPS)[number];

export interface Ref {
  sourceId: string;
  path: string;
}

interface Args {
  op: Op;
  a: Ref[];
  /** true when `a` was given as an array (a list of refs) */
  aList: boolean;
  b?: Ref;
}

const MAX_REFS = 50;
const KEY = "[A-Za-z0-9_]{1,64}";
const PATH_TOTALS = new RegExp(`^totals\\.(${KEY})$`);
const PATH_ROW = new RegExp(`^rows\\.(\\d{1,4})\\.(${KEY})$`);
const PATH_COLUMN = new RegExp(`^column\\.(${KEY})$`);
const PATH_HELP = 'Use "totals.<key>", "rows.<index>.<key>" or "column.<key>"';

const REF_SCHEMA = {
  type: "object",
  properties: {
    sourceId: { type: "string", description: "The source id of an earlier result in this conversation turn (for example r1)" },
    path: { type: "string", description: "totals.<key>, rows.<index>.<key> (index from 0) or column.<key>" },
  },
  required: ["sourceId", "path"],
  additionalProperties: false,
};

function parseRef(v: unknown, name: string): Ref {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ToolInputError(`"${name}" must be an object {"sourceId": "...", "path": "..."}`);
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== "sourceId" && k !== "path");
  if (extra.length > 0) throw new ToolInputError(`"${name}" has unknown field(s): ${extra.slice(0, 5).join(", ")}. Allowed: sourceId, path`);
  if (typeof o.sourceId !== "string" || o.sourceId.trim() === "" || o.sourceId.length > 64) throw new ToolInputError(`"${name}.sourceId" must be the source id of an earlier result`);
  if (typeof o.path !== "string" || !(PATH_TOTALS.test(o.path) || PATH_ROW.test(o.path) || PATH_COLUMN.test(o.path))) {
    throw new ToolInputError(`"${name}.path" is not valid. ${PATH_HELP}`);
  }
  return { sourceId: o.sourceId.trim(), path: o.path };
}

function readResults(ctx: ToolContext): ReadonlyMap<string, ToolResult> | undefined {
  return (ctx as ToolContext & { results?: ReadonlyMap<string, ToolResult> }).results;
}

interface Resolved {
  values: number[];
  format: ColumnFormat;
  text: string;
}

function resolveRef(ref: Ref, results: ReadonlyMap<string, ToolResult>): Resolved {
  const source = results.get(ref.sourceId);
  if (!source) {
    throw new ToolInputError(`No result with sourceId "${ref.sourceId}" in this request. Available: ${[...results.keys()].slice(0, 10).join(", ")}`);
  }
  const text = `${ref.path} of ${ref.sourceId}`;
  const formatOf = (key: string): ColumnFormat | undefined => source.columns.find((c) => c.key === key)?.format;
  const cell = (v: unknown, where: string): number | null => {
    if (v === null) return null;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolInputError(`${where} is not a number (${typeof v === "string" ? `"${v.slice(0, 40)}"` : String(v)}). Only numeric fields can be calculated`);
    return v;
  };

  let m = PATH_TOTALS.exec(ref.path);
  if (m) {
    if (!source.totals) throw new ToolInputError(`${ref.sourceId} has no totals. Use rows.<index>.<key> or column.<key>`);
    if (!(m[1] in source.totals)) throw new ToolInputError(`${ref.sourceId} totals have no "${m[1]}". Available: ${Object.keys(source.totals).join(", ")}`);
    const n = cell(source.totals[m[1]], text);
    if (n === null) throw new ToolInputError(`${text} is empty (no value)`);
    return { values: [n], format: formatOf(m[1]) ?? "text", text };
  }
  m = PATH_ROW.exec(ref.path);
  if (m) {
    const row = source.rows[Number(m[1])];
    if (!row) throw new ToolInputError(`${ref.sourceId} has ${source.rows.length} row(s); row ${m[1]} does not exist (rows start at 0)`);
    if (!(m[2] in row)) throw new ToolInputError(`${ref.sourceId} rows have no "${m[2]}". Available: ${Object.keys(row).join(", ")}`);
    const n = cell(row[m[2]], text);
    if (n === null) throw new ToolInputError(`${text} is empty (no value)`);
    return { values: [n], format: formatOf(m[2]) ?? "text", text };
  }
  m = PATH_COLUMN.exec(ref.path);
  const key = (m as RegExpExecArray)[1]; // parseRef already guaranteed one of the three forms
  const colFormat = formatOf(key);
  if (!colFormat) throw new ToolInputError(`${ref.sourceId} has no column "${key}". Available: ${source.columns.map((c) => c.key).join(", ")}`);
  const values: number[] = [];
  source.rows.forEach((row, i) => {
    const n = cell(row[key], `${ref.sourceId} row ${i} ${key}`);
    if (n !== null) values.push(n);
  });
  if (values.length === 0) throw new ToolInputError(`${text} has no numeric values`);
  return { values, format: colFormat, text };
}

const describeRefs = (rs: Resolved[]): string => (rs.length === 1 ? rs[0].text : `${rs.length} values (${rs.slice(0, 3).map((r) => r.text).join("; ")}${rs.length > 3 ? "; ..." : ""})`);

function sameKind(a: ColumnFormat, b: ColumnFormat, op: Op): void {
  if (a !== b) throw new ToolInputError(`Cannot ${op.replace("_", " ")} a ${a} value and a ${b} value. Use two values of the same kind (or op "ratio" / "percent_of")`);
}

export const calculate: ToolDefinition<Args> = {
  name: "calculate",
  label: "Calculation",
  readOnly: true,
  description:
    "Exact arithmetic over figures you already fetched in this conversation turn, so a comparison or percentage is correct and shown as data. Never do the arithmetic yourself: call this. No database access. " +
    "op: sum (add the values in a), average (mean of the values in a), difference (a minus b), percent_change ((a - b) / b * 100: a is the new value, b the old or baseline), percent_of (a as a percentage of b), ratio (a / b, for example revenue per job), rank (position of b among the values of a, 1 = highest). " +
    "a and b are references {\"sourceId\":\"r1\",\"path\":\"totals.revenue\"}; path is totals.<key>, rows.<index>.<key> (index starts at 0) or column.<key> (every value of that column, for sum, average and rank). sum and average also accept a as a list of references. " +
    "Examples: {\"op\":\"percent_change\",\"a\":{\"sourceId\":\"r2\",\"path\":\"totals.revenue\"},\"b\":{\"sourceId\":\"r3\",\"path\":\"totals.revenue\"}}; {\"op\":\"sum\",\"a\":{\"sourceId\":\"r1\",\"path\":\"column.balance\"}}. " +
    "Returns one row {label, value}; value is null with a note row when b is zero. Use only with source ids from this turn; never invent a sourceId. Do not use it to total a list the user could already see (totals exist).",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: [...OPS] },
      a: { description: "A reference, or for sum and average a list of up to 50 references", anyOf: [REF_SCHEMA, { type: "array", items: REF_SCHEMA, minItems: 1, maxItems: MAX_REFS }] },
      b: { ...REF_SCHEMA, description: "Second reference (required for difference, percent_change, percent_of, ratio and rank)" },
    },
    required: ["op", "a"],
    additionalProperties: false,
  },
  parse(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ToolInputError("Arguments must be a JSON object with op and a");
    const obj = raw as Record<string, unknown>;
    const unknown = Object.keys(obj).filter((k) => !["op", "a", "b"].includes(k));
    if (unknown.length > 0) throw new ToolInputError(`Unknown argument(s): ${unknown.slice(0, 5).join(", ")}. Allowed: op, a, b`);
    const op = obj.op;
    if (typeof op !== "string" || !(OPS as readonly string[]).includes(op)) throw new ToolInputError(`"op" must be one of: ${OPS.join(", ")}`);
    if (obj.a === undefined || obj.a === null) throw new ToolInputError('"a" is required');
    const aList = Array.isArray(obj.a);
    let a: Ref[];
    if (Array.isArray(obj.a)) {
      if (obj.a.length === 0 || obj.a.length > MAX_REFS) throw new ToolInputError(`"a" must list 1 to ${MAX_REFS} references`);
      a = obj.a.map((r, i) => parseRef(r, `a[${i}]`));
    } else a = [parseRef(obj.a, "a")];
    const hasB = obj.b !== undefined && obj.b !== null;
    const needsB = op !== "sum" && op !== "average";
    if (needsB && !hasB) throw new ToolInputError(`"b" is required for ${op}`);
    if (!needsB && hasB) throw new ToolInputError(`"b" is not used by ${op}`);
    if (aList && !["sum", "average", "rank"].includes(op)) throw new ToolInputError(`"a" must be a single reference for ${op}; a list works for sum, average and rank`);
    return { op: op as Op, a, aList, b: hasB ? parseRef(obj.b, "b") : undefined };
  },
  async run(args, ctx) {
    const results = readResults(ctx);
    if (!results || results.size === 0) throw new ToolInputError("There are no earlier results to calculate from. Call a data tool first, then use its sourceId");
    const as = args.a.map((r) => resolveRef(r, results));
    const aValues = as.flatMap((r) => r.values);
    const aFormat = as[0].format;
    for (const r of as) sameKind(aFormat, r.format, args.op);

    let value: number | null;
    let format: ColumnFormat = aFormat;
    let label: string;
    let note: string | null = null;

    if (args.op === "sum") {
      value = aValues.reduce((n, v) => n + v, 0);
      label = `Sum of ${describeRefs(as)}`;
    } else if (args.op === "average") {
      value = aValues.reduce((n, v) => n + v, 0) / aValues.length;
      label = `Average of ${describeRefs(as)}`;
    } else {
      const b = resolveRef(args.b as Ref, results);
      if (args.op !== "rank" && (aValues.length !== 1 || b.values.length !== 1)) {
        throw new ToolInputError(`${args.op} needs one value on each side; use rows.<index>.<key> or totals.<key>, or sum/average a column first`);
      }
      if (args.op === "rank") {
        if (b.values.length !== 1) throw new ToolInputError('For rank, "b" must be a single value (totals.<key> or rows.<index>.<key>)');
        sameKind(aFormat, b.format, args.op);
        if (!aValues.includes(b.values[0])) throw new ToolInputError('For rank, "b" must be one of the values referenced by "a"');
        value = 1 + aValues.filter((v) => v > b.values[0]).length;
        format = "integer";
        label = `Rank of ${b.text} among ${aValues.length} values (1 = highest)`;
      } else {
        if (args.op === "difference" || args.op === "percent_change") sameKind(aFormat, b.format, args.op);
        const x = aValues[0];
        const y = b.values[0];
        const divides = args.op !== "difference";
        if (divides && y === 0) {
          value = null;
          note = `Note: ${b.text} is 0, so ${args.op.replace("_", " ")} cannot be calculated`;
        } else if (args.op === "difference") value = x - y;
        else if (args.op === "percent_change") value = ((x - y) / y) * 100;
        else if (args.op === "percent_of") value = (x / y) * 100;
        else value = x / y;
        format = args.op === "difference" ? aFormat : args.op === "ratio" ? (aFormat === "currency" && b.format !== "currency" ? "currency" : "text") : "percent";
        const name = { difference: "Difference", percent_change: "Percent change", percent_of: "Percent of", ratio: "Ratio" }[args.op];
        label = `${name}: ${as[0].text} vs ${b.text}`;
      }
    }

    if (value !== null && !Number.isFinite(value)) throw new ToolInputError("The result is outside the range that can be calculated");
    const rows: ResultRow[] = [{ label, value: value === null ? null : args.op === "rank" ? value : round2(value) }];
    if (note) rows.push({ label: note, value: null });
    return { dateRange: null, rows, totals: null, truncated: false, columns: columns(["label", "Calculation", "text"], ["value", "Value", format]) };
  },
};
