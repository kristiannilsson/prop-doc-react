#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ALL_FINDING_KINDS, DEFAULT_MIN_SITES, analyzeProject } from '../lib/analyze.mjs';
import type { AnalyzeResult, Finding, FindingKind } from '../lib/analyzer/types.mjs';

const DEFAULT_BASELINE_PATH = '.prop-doc-baseline.json';
const BASELINE_VERSION = 1;

const HELP = `Usage: prop-doc [tsconfig path] [options]

Finds optional props on React components that no parent ever passes.

Arguments:
  tsconfig path              defaults to ./tsconfig.json

Options:
  --json                     machine-readable output
  --verbose                  also list components skipped due to untyped spreads
  --include-test-components  analyze components defined in test/story files too
  --rules <list>             comma-separated rules to run (default: all)
                             ${ALL_FINDING_KINDS.join(', ')}
  --min-sites <n>            non-test sites required before statistical rules
                             (always, boolean one-sided, union variants) fire
                             (default: ${DEFAULT_MIN_SITES})
  --baseline <path>          ignore findings recorded in this baseline file;
                             only new findings are reported and gate the exit
                             code (default path: ${DEFAULT_BASELINE_PATH})
  --write-baseline           record the current findings to the baseline file
                             and exit 0
  --help                     show this help

Suppress a finding at the source with a comment on the prop declaration:
  someProp?: string; // prop-doc-ignore            (all rules)
  someProp?: string; // prop-doc-ignore never      (specific rules)

Exit codes: 1 if any new definite high-confidence finding (never, tests-only),
0 if clean or only advisory/low-confidence/baselined findings, 2 on usage errors.
`;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function color(code: number, text: string): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function heading(text: string): string {
  return color(36, text);
}

function subdued(text: string): string {
  return color(90, text);
}

function kindTag(kind: Finding['kind']): string {
  if (kind === 'never') return color(31, '[never]');
  if (kind === 'tests-only') return color(35, '[tests-only]');
  if (kind === 'unconsumed') return color(31, '[unconsumed]');
  if (kind === 'callback-never-invoked') return color(31, '[callback-never-invoked]');
  if (kind === 'default-never-used') return color(33, '[default-never-used]');
  if (kind === 'always') return color(33, '[always]');
  if (kind === 'boolean-never-true') return color(34, '[bool-never-true]');
  if (kind === 'boolean-never-false') return color(34, '[bool-never-false]');
  if (kind === 'union-variant-never') return color(34, '[union-variant-never]');
  return `[${kind}]`;
}

function findingStatus(f: Finding): string {
  if (f.kind === 'never') return 'never passed by any parent';
  if (f.kind === 'tests-only') return 'only passed from test/story files';
  if (f.kind === 'unconsumed') return 'accepted but never read or forwarded by the component body';
  if (f.kind === 'callback-never-invoked') return 'callback passed by parents but never referenced by the component';
  if (f.kind === 'default-never-used') {
    return `destructuring default never exercised (all ${f.nonTestRenderSites} non-test render site(s) pass a defined value)`;
  }
  if (f.kind === 'always') {
    return `passed by every non-test parent (${f.nonTestRenderSites} non-test render site(s))`;
  }
  if (f.kind === 'boolean-never-true') return 'boolean is only ever passed false when provided';
  if (f.kind === 'boolean-never-false') return 'boolean is only ever passed true when provided';
  if (f.kind === 'union-variant-never') {
    return `union variant(s) never passed: ${f.missingVariants?.join(', ') ?? ''}`;
  }
  return f.kind;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

function usageError(message: string): never {
  console.error(`${message}\n\n${HELP}`);
  process.exit(2);
}

let asJson = false;
let verbose = false;
let includeTestComponents = false;
let rules: FindingKind[] | undefined;
let minSites: number | undefined;
let baselinePath: string | undefined;
let writeBaseline = false;
const positional: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!arg.startsWith('--')) {
    positional.push(arg);
    continue;
  }
  const eq = arg.indexOf('=');
  const flag = eq === -1 ? arg : arg.slice(0, eq);
  const takeValue = (): string => {
    if (eq !== -1) return arg.slice(eq + 1);
    const next = args[++i];
    if (next === undefined || next.startsWith('--')) usageError(`${flag} requires a value`);
    return next;
  };

  if (flag === '--json') asJson = true;
  else if (flag === '--verbose') verbose = true;
  else if (flag === '--include-test-components') includeTestComponents = true;
  else if (flag === '--rules') {
    const names = takeValue().split(',').map((r) => r.trim()).filter(Boolean);
    const bad = names.filter((r) => !(ALL_FINDING_KINDS as string[]).includes(r));
    if (bad.length > 0) usageError(`Unknown rule(s): ${bad.join(', ')}`);
    if (names.length === 0) usageError('--rules requires at least one rule');
    rules = names as FindingKind[];
  } else if (flag === '--min-sites') {
    const n = Number(takeValue());
    if (!Number.isInteger(n) || n < 1) usageError('--min-sites requires a positive integer');
    minSites = n;
  } else if (flag === '--baseline') baselinePath = takeValue();
  else if (flag === '--write-baseline') writeBaseline = true;
  else usageError(`Unknown option: ${arg}`);
}

const tsconfigPath = positional[0] ?? 'tsconfig.json';

let result: AnalyzeResult;
try {
  result = analyzeProject(tsconfigPath, { includeTestComponents, rules, minSites });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(2);
}

const { findings, skipped, componentsAnalyzed } = result;

const cwd = process.cwd();
const rel = (fileName: string): string => path.relative(cwd, fileName).replaceAll('\\', '/');

// Baseline entries store paths relative to the baseline file so the file can
// be committed and used regardless of the invocation directory.
const resolvedBaseline = path.resolve(baselinePath ?? DEFAULT_BASELINE_PATH);
const baselineDir = path.dirname(resolvedBaseline);
const baselineFile = (f: Finding): string =>
  path.relative(baselineDir, f.file).replaceAll('\\', '/');
const baselineKey = (f: Finding): string =>
  [baselineFile(f), f.component, f.prop, f.kind].join('|');

if (writeBaseline) {
  const entries = findings.map((f) => ({
    file: baselineFile(f),
    component: f.component,
    prop: f.prop,
    kind: f.kind,
  }));
  try {
    fs.writeFileSync(
      resolvedBaseline,
      `${JSON.stringify({ version: BASELINE_VERSION, findings: entries }, null, 2)}\n`,
    );
  } catch (error) {
    console.error(
      `Could not write baseline file ${resolvedBaseline}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
  console.log(`Wrote ${entries.length} finding(s) to ${rel(resolvedBaseline)}.`);
  process.exit(0);
}

let baselined = new Set<string>();
if (baselinePath !== undefined) {
  let raw: string;
  try {
    raw = fs.readFileSync(resolvedBaseline, 'utf8');
  } catch {
    usageError(`Could not read baseline file: ${baselinePath} (create one with --write-baseline)`);
  }
  let parsedBaseline: { version?: number; findings?: { file: string; component: string; prop: string; kind: string }[] };
  try {
    parsedBaseline = JSON.parse(raw);
  } catch {
    usageError(`Baseline file is not valid JSON: ${baselinePath}`);
  }
  if (parsedBaseline.version !== BASELINE_VERSION || !Array.isArray(parsedBaseline.findings)) {
    usageError(`Unsupported baseline file format in ${baselinePath}; regenerate with --write-baseline`);
  }
  baselined = new Set(
    parsedBaseline.findings.map((e) => [e.file, e.component, e.prop, e.kind].join('|')),
  );
}

const isBaselined = (f: Finding): boolean => baselined.has(baselineKey(f));

// Only NEW dead-code findings the analysis is sure about fail the CI gate;
// advisory rules, low-confidence findings, and baselined findings never
// affect the exit code.
const gates = (f: Finding): boolean =>
  f.severity === 'definite' && !f.lowConfidence && !isBaselined(f);

function printFindingSection(title: string, sectionFindings: Finding[]): void {
  if (sectionFindings.length === 0) return;

  console.log(`\n${heading(title)} ${subdued(`(${sectionFindings.length})`)}`);

  let currentFile: string | undefined;
  let currentComponent: string | undefined;

  for (const finding of sectionFindings) {
    if (rel(finding.file) !== currentFile) {
      currentFile = rel(finding.file);
      currentComponent = undefined;
      console.log(`\n${subdued(currentFile)}`);
    }
    if (finding.component !== currentComponent) {
      currentComponent = finding.component;
      const confidence = finding.lowConfidence ? ' [low confidence: also referenced as a value]' : '';
      console.log(`  <${finding.component}> — ${finding.renderSites} render site(s)${confidence}`);
    }
    const tag = kindTag(finding.kind);
    console.log(`    ${finding.prop.padEnd(28)} ${tag} ${findingStatus(finding)}`);
  }
}

if (asJson) {
  console.log(
    JSON.stringify(
      {
        findings: findings.map((f) => ({
          ...f,
          ...(baselinePath !== undefined ? { baselined: isBaselined(f) } : {}),
          file: rel(f.file),
          testFiles: f.testFiles?.map(rel),
        })),
        skippedForOpaqueSpread: skipped.map((s) => ({
          ...s,
          file: rel(s.file),
          spreadIn: s.spreadIn.map(rel),
        })),
        componentsAnalyzed,
      },
      null,
      2,
    ),
  );
} else {
  const shown = findings.filter((f) => !isBaselined(f));
  const baselinedCount = findings.length - shown.length;

  printFindingSection('Definite Findings', shown.filter(gates));
  printFindingSection('Advisory Findings', shown.filter((f) => !gates(f)));

  if (verbose && skipped.length > 0) {
    console.log(`\n${heading('Skipped Components')} ${subdued('(opaque spread may pass any prop)')}`);
    for (const entry of skipped) console.log(`  <${entry.component}> in ${rel(entry.file)}`);
  }

  const baselineNote = baselinePath === undefined ? '' : ` ${baselinedCount} baselined finding(s) hidden.`;
  console.log(
    `\n${shown.length} finding(s) across ${new Set(shown.map((f) => `${f.file}:${f.component}`)).size} component(s)` +
      ` (${shown.filter(gates).length} definite).${baselineNote} ${componentsAnalyzed} components analyzed, ${skipped.length} skipped.`,
  );
}

process.exit(findings.some(gates) ? 1 : 0);
