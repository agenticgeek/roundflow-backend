// Diff coverage gate: every added/changed line in a changed src/ file must be
// covered by the test suite. Complements the per-file 100% gates in
// vitest.config.ts for files that are too large/legacy to gate whole.
//
//   npm run test:diff-coverage            # local: working tree vs HEAD (+ untracked files)
//   CI=true npm run test:diff-coverage    # CI: origin/main...HEAD
//   DIFF_BASE=origin/develop npm run test:diff-coverage   # explicit base (CI-style)
//
// A line counts as "uncovered" with istanbul semantics (what "% Lines" in the
// coverage report uses): a statement starting on that line was never run.
// Blank lines, comments and type-only lines carry no statements and are
// ignored. Uncovered branches on changed lines are reported as warnings only.
/* global process, console */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { startVitest } from "vitest/node";

const ROOT = process.cwd();
const REPORT_DIR = path.join(ROOT, "coverage", "diff");

// Not executable under unit tests: process entry point (env checks + listen).
const IGNORED = new Set(["src/index.ts"]);

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

const isSource = (f) =>
  f.startsWith("src/") &&
  f.endsWith(".ts") &&
  !f.endsWith(".d.ts") &&
  !f.endsWith(".test.ts") &&
  !f.includes("/__tests__/") &&
  !f.startsWith("src/generated/") &&
  !f.startsWith("src/test/") &&
  !IGNORED.has(f);

// git diff -U0 hunk headers → Set of added/changed line numbers (new side).
function changedLines(diffText) {
  const lines = new Set();
  for (const m of diffText.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) lines.add(start + i);
  }
  return lines;
}

function collectChanges() {
  const ciBase = process.env.DIFF_BASE ?? (process.env.CI ? "origin/main...HEAD" : null);
  const range = ciBase ?? "HEAD";
  const changes = new Map();

  const files = git("diff", "--name-only", "--diff-filter=AMR", range).split("\n").map((f) => f.trim()).filter(isSource);
  for (const f of files) {
    const lines = changedLines(git("diff", "-U0", range, "--", f));
    if (lines.size) changes.set(f, lines);
  }

  if (!ciBase) {
    // Untracked files are entirely new.
    const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").map((f) => f.trim()).filter(isSource);
    for (const f of untracked) {
      const count = readFileSync(path.join(ROOT, f), "utf8").split("\n").length;
      changes.set(f, new Set(Array.from({ length: count }, (_, i) => i + 1)));
    }
  }
  return { range: ciBase ?? "HEAD (working tree + untracked)", changes };
}

async function runCoverage(files) {
  if (existsSync(REPORT_DIR)) rmSync(REPORT_DIR, { recursive: true, force: true });
  const vitest = await startVitest("test", [], {
    watch: false,
    coverage: {
      enabled: true,
      provider: "v8",
      include: files,
      reporter: ["json"],
      reportsDirectory: REPORT_DIR,
      thresholds: { 100: false, perFile: false },
    },
  });
  const failed = vitest?.state.getCountOfFailedTests() ?? 1;
  await vitest?.close();
  if (failed > 0) throw new Error(`${failed} test(s) failed — fix the suite before checking diff coverage`);
  return JSON.parse(readFileSync(path.join(REPORT_DIR, "coverage-final.json"), "utf8"));
}

function uncovered(fileCov, changed) {
  const missLines = new Set();
  for (const [id, loc] of Object.entries(fileCov.statementMap)) {
    if (fileCov.s[id] === 0 && changed.has(loc.start.line)) missLines.add(loc.start.line);
  }
  // A line is covered when any statement starting on it ran (istanbul line semantics).
  for (const [id, loc] of Object.entries(fileCov.statementMap)) {
    if (fileCov.s[id] > 0) missLines.delete(loc.start.line);
  }
  const missBranches = new Set();
  for (const [id, b] of Object.entries(fileCov.branchMap)) {
    b.locations.forEach((loc, i) => {
      const line = loc?.start?.line ?? b.loc.start.line;
      if (fileCov.b[id][i] === 0 && changed.has(line)) missBranches.add(line);
    });
  }
  return { lines: [...missLines].sort((a, b) => a - b), branches: [...missBranches].sort((a, b) => a - b) };
}

const ranges = (nums) => {
  const out = [];
  for (const n of nums) {
    const last = out[out.length - 1];
    if (last && last[1] === n - 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
};

const { range, changes } = collectChanges();
console.log(`[diff-coverage] base: ${range}; ${changes.size} changed source file(s)`);
if (changes.size === 0) process.exit(0);

const coverage = await runCoverage([...changes.keys()]);
const byFile = new Map(Object.entries(coverage).map(([abs, cov]) => [path.relative(ROOT, abs).replace(/\\/g, "/"), cov]));

let failures = 0;
let changedTotal = 0;
for (const [file, lines] of [...changes].sort(([a], [b]) => a.localeCompare(b))) {
  changedTotal += lines.size;
  const cov = byFile.get(file);
  if (!cov) {
    console.error(`  FAIL ${file}: never loaded by any test`);
    failures++;
    continue;
  }
  const miss = uncovered(cov, lines);
  if (miss.lines.length) {
    console.error(`  FAIL ${file}: uncovered changed line(s) ${ranges(miss.lines)}`);
    failures++;
  }
  if (miss.branches.length) console.warn(`  warn ${file}: uncovered branch(es) on changed line(s) ${ranges(miss.branches)}`);
}

if (failures) {
  console.error(`[diff-coverage] FAILED: ${failures} file(s) with uncovered changed lines`);
  process.exit(1);
}
console.log(`[diff-coverage] OK: all ${changedTotal} changed line(s) across ${changes.size} file(s) are covered`);
process.exit(0);
