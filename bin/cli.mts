#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { ALL_FINDING_KINDS, DEFAULT_MIN_SITES, analyzeProject } from '../lib/analyze.mjs';
import {
  BaselineError,
  DEFAULT_BASELINE_PATH,
  loadBaseline,
  writeBaseline,
} from '../lib/baseline.mjs';
import { applyFixes, planFixes } from '../lib/fixer.mjs';
import type { AppliedEdit } from '../lib/fixer.mjs';
import type { AnalyzeResult, Finding, FindingKind } from '../lib/analyzer/types.mjs';

const HELP = `Usage: prop-doc [tsconfig paths...] [options]

Finds React prop-API drift: dead optional props, props the component body
never reads, never-invoked callbacks, dead union variants, and callsites
that restate the destructuring default.

Arguments:
  tsconfig paths             one or more tsconfig.json paths, merged into one
                             program so cross-package render sites are visible
                             (default: ./tsconfig.json); TypeScript project
                             references are followed automatically

Options:
  --json                     machine-readable output
  --verbose                  also list components skipped due to untyped spreads
  --include-test-components  analyze components defined in test/story files too
  --rules <list>             comma-separated rules to run (default: all)
                             ${ALL_FINDING_KINDS.join(', ')}
  --min-sites <n>            non-test sites required before statistical rules
                             (always, union variants, same-literal) fire
                             (default: ${DEFAULT_MIN_SITES})
  --baseline <path>          ignore findings recorded in this baseline file;
                             only new findings are reported and gate the exit
                             code (default path: ${DEFAULT_BASELINE_PATH})
  --write-baseline           record the current findings to the baseline file
                             and exit 0
  --assume-internal          skip public-API detection: treat every component
                             as having no consumers outside this program
  --fix                      apply safe fixes, then re-analyze and report what
                             remains; fixes passed-equals-default and
                             same-literal (delete/fold redundant attributes),
                             type-wider-than-usage (narrow the type),
                             union-variant-never (prune unseen variants), and
                             never/unconsumed/callback-never-invoked (remove
                             the prop when verifiably safe); low-confidence,
                             public-API, and baselined findings are never
                             fixed
  --dry-run                  with --fix: print the planned edits without
                             changing any file
  --help                     show this help

Suppress a finding at the source with a comment on the prop declaration:
  someProp?: string; // prop-doc-ignore            (all rules)
  someProp?: string; // prop-doc-ignore never      (specific rules)

Exit codes: 1 if any new definite high-confidence finding (never, tests-only,
unconsumed, callback-never-invoked), 0 if clean or only advisory/low-confidence/
baselined findings, 2 on usage errors.
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

const KIND_COLORS: Record<FindingKind, number> = {
  never: 31,
  unconsumed: 31,
  'callback-never-invoked': 31,
  'tests-only': 35,
  always: 33,
  'same-literal': 33,
  'passed-equals-default': 33,
  'type-wider-than-usage': 34,
  'union-variant-never': 34,
};

function kindTag(kind: FindingKind): string {
  return color(KIND_COLORS[kind], `[${kind}]`);
}

const KIND_STATUS: Record<FindingKind, (f: Finding) => string> = {
  never: () => 'never passed by any parent',
  'tests-only': () => 'only passed from test/story files',
  unconsumed: () => 'accepted but never read or forwarded by the component body',
  'callback-never-invoked': () =>
    'callback passed by parents but never referenced by the component',
  always: (f) =>
    `passed by every non-test parent (${f.nonTestRenderSites} non-test render site(s))`,
  'same-literal': (f) => `always passed the same value when provided: ${f.literalValue}`,
  'passed-equals-default': (f) =>
    `every provided value equals the destructuring default (${f.literalValue}); the attribute is redundant`,
  'type-wider-than-usage': (f) =>
    `type is wider than usage; only ever passed: ${f.observedValues?.join(', ') ?? ''} — consider a union type`,
  'union-variant-never': (f) =>
    `union variant(s) never passed: ${f.missingVariants?.join(', ') ?? ''}`,
};

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

function usageError(message: string): never {
  console.error(`${message}\n\n${HELP}`);
  process.exit(2);
}

function parseCli() {
  try {
    return parseArgs({
      args,
      options: {
        json: { type: 'boolean' },
        verbose: { type: 'boolean' },
        'include-test-components': { type: 'boolean' },
        rules: { type: 'string' },
        'min-sites': { type: 'string' },
        baseline: { type: 'string' },
        'write-baseline': { type: 'boolean' },
        'assume-internal': { type: 'boolean' },
        fix: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }
}

const { values, positionals } = parseCli();

const asJson = values.json ?? false;
const verbose = values.verbose ?? false;
const includeTestComponents = values['include-test-components'] ?? false;
const writeBaselineMode = values['write-baseline'] ?? false;
const assumeInternal = values['assume-internal'] ?? false;
const fixMode = values.fix ?? false;
const dryRun = values['dry-run'] ?? false;
const baselinePath = values.baseline;

let rules: FindingKind[] | undefined;
if (values.rules !== undefined) {
  const names = values.rules
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  const bad = names.filter((r) => !(ALL_FINDING_KINDS as string[]).includes(r));
  if (bad.length > 0) usageError(`Unknown rule(s): ${bad.join(', ')}`);
  if (names.length === 0) usageError('--rules requires at least one rule');
  rules = names as FindingKind[];
}

let minSites: number | undefined;
if (values['min-sites'] !== undefined) {
  const n = Number(values['min-sites']);
  if (!Number.isInteger(n) || n < 1) usageError('--min-sites requires a positive integer');
  minSites = n;
}

if (dryRun && !fixMode) usageError('--dry-run requires --fix');
if (fixMode && writeBaselineMode) usageError('--fix cannot be combined with --write-baseline');

const tsconfigPaths = positionals.length > 0 ? positionals : ['tsconfig.json'];

let result: AnalyzeResult;
try {
  result = analyzeProject(tsconfigPaths, {
    includeTestComponents,
    rules,
    minSites,
    assumeInternal,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(2);
}

let { findings, skipped, componentsAnalyzed } = result;

const cwd = process.cwd();
const rel = (fileName: string): string => path.relative(cwd, fileName).replaceAll('\\', '/');

let isBaselined = (_f: Finding): boolean => false;
try {
  if (writeBaselineMode) {
    const { resolvedPath, count } = writeBaseline(baselinePath ?? DEFAULT_BASELINE_PATH, findings);
    console.log(`Wrote ${count} finding(s) to ${rel(resolvedPath)}.`);
    process.exit(0);
  }
  if (baselinePath !== undefined) isBaselined = loadBaseline(baselinePath);
} catch (error) {
  if (error instanceof BaselineError) usageError(error.message);
  throw error;
}

let fixResult: { edits: AppliedEdit[]; findingsFixed: number } | undefined;
if (fixMode) {
  const plan = planFixes(findings, isBaselined);
  fixResult = { edits: applyFixes(plan, { dryRun }), findingsFixed: plan.findings.length };
  if (!dryRun && fixResult.edits.length > 0) {
    // Re-analyze on a fresh program so the report reflects the post-fix state.
    ({ findings, skipped, componentsAnalyzed } = analyzeProject(tsconfigPaths, {
      includeTestComponents,
      rules,
      minSites,
      assumeInternal,
    }));
  }
}

const gates = (f: Finding): boolean =>
  f.severity === 'definite' && !f.lowConfidence && !f.publicApi && !isBaselined(f);

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
      const markers =
        (finding.lowConfidence ? ' [low confidence: also referenced as a value]' : '') +
        (finding.publicApi ? ' [public API: may have consumers outside this program]' : '');
      console.log(`  <${finding.component}> — ${finding.renderSites} render site(s)${markers}`);
    }
    console.log(
      `    ${finding.prop.padEnd(28)} ${kindTag(finding.kind)} ${KIND_STATUS[finding.kind](finding)}`,
    );
  }
}

if (asJson) {
  console.log(
    JSON.stringify(
      {
        ...(fixResult === undefined
          ? {}
          : {
              fixes: {
                dryRun,
                findingsFixed: fixResult.findingsFixed,
                edits: fixResult.edits.map((e) => ({ ...e, file: rel(e.file) })),
              },
            }),
        findings: findings.map((f) => ({
          ...f,
          ...(baselinePath !== undefined ? { baselined: isBaselined(f) } : {}),
          file: rel(f.file),
          testFiles: f.testFiles?.map(rel),
          fix: f.fix?.map((e) => ({ ...e, file: rel(e.file) })),
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
  if (fixResult !== undefined) {
    if (fixResult.edits.length === 0) {
      console.log('\nNo fixable findings.');
    } else {
      const title = dryRun ? 'Planned Fixes (no files changed)' : 'Applied Fixes';
      console.log(
        `\n${heading(title)} ${subdued(`(${fixResult.edits.length} edit(s) for ${fixResult.findingsFixed} finding(s))`)}`,
      );
      for (const edit of fixResult.edits) {
        const change =
          edit.removed && edit.newText
            ? `replaced ${edit.removed} with ${edit.newText.trim()}`
            : edit.removed
              ? `removed ${edit.removed}`
              : `inserted ${edit.newText.trim()}`;
        console.log(`  ${rel(edit.file)}:${edit.line}  ${change}`);
      }
    }
  }

  const shown = findings.filter((f) => !isBaselined(f));
  const baselinedCount = findings.length - shown.length;

  printFindingSection('Definite Findings', shown.filter(gates));
  printFindingSection(
    'Advisory Findings',
    shown.filter((f) => !gates(f)),
  );

  if (verbose && skipped.length > 0) {
    console.log(
      `\n${heading('Skipped Components')} ${subdued('(opaque spread may pass any prop)')}`,
    );
    for (const entry of skipped) console.log(`  <${entry.component}> in ${rel(entry.file)}`);
  }

  const baselineNote =
    baselinePath === undefined ? '' : ` ${baselinedCount} baselined finding(s) hidden.`;
  console.log(
    `\n${shown.length} finding(s) across ${new Set(shown.map((f) => `${f.file}:${f.component}`)).size} component(s)` +
      ` (${shown.filter(gates).length} definite).${baselineNote} ${componentsAnalyzed} components analyzed, ${skipped.length} skipped.`,
  );
}

process.exit(findings.some(gates) ? 1 : 0);
