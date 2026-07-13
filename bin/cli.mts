#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { analyzeProject } from '../lib/analyze.mjs';
import type { AnalyzeResult, Finding } from '../lib/analyzer/types.mjs';

const HELP = `Usage: prop-doc [tsconfig path] [options]

Finds optional props on React components that no parent ever passes.

Arguments:
  tsconfig path              defaults to ./tsconfig.json

Options:
  --json                     machine-readable output
  --verbose                  also list components skipped due to untyped spreads
  --include-test-components  analyze components defined in test/story files too
  --help                     show this help
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
  if (kind === 'always') return color(33, '[always]');
  if (kind === 'boolean-never-true') return color(34, '[bool-never-true]');
  if (kind === 'boolean-never-false') return color(34, '[bool-never-false]');
  if (kind === 'union-variant-never') return color(34, '[union-variant-never]');
  return `[${kind}]`;
}

function findingStatus(f: Finding): string {
  if (f.kind === 'never') return 'never passed by any parent';
  if (f.kind === 'tests-only') return 'only passed from test/story files';
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

const KNOWN_FLAGS = new Set(['--json', '--verbose', '--include-test-components']);
const unknown = args.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a));
if (unknown.length > 0) {
  console.error(`Unknown option(s): ${unknown.join(', ')}\n\n${HELP}`);
  process.exit(2);
}

const asJson = args.includes('--json');
const verbose = args.includes('--verbose');
const includeTestComponents = args.includes('--include-test-components');
const positional = args.filter((a) => !a.startsWith('--'));
const tsconfigPath = positional[0] ?? 'tsconfig.json';

let result: AnalyzeResult;
try {
  result = analyzeProject(tsconfigPath, { includeTestComponents });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(2);
}

const { findings, skipped, componentsAnalyzed } = result;
const cwd = process.cwd();
const rel = (fileName: string): string => path.relative(cwd, fileName).replaceAll('\\', '/');

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
  const definiteFindings = findings.filter((f) => !f.lowConfidence);
  const advisoryFindings = findings.filter((f) => f.lowConfidence);

  printFindingSection('Definite Findings', definiteFindings);
  printFindingSection('Advisory Findings', advisoryFindings);

  if (verbose && skipped.length > 0) {
    console.log(`\n${heading('Skipped Components')} ${subdued('(opaque spread may pass any prop)')}`);
    for (const entry of skipped) console.log(`  <${entry.component}> in ${rel(entry.file)}`);
  }

  const definite = findings.filter((f) => !f.lowConfidence).length;
  console.log(
    `\n${findings.length} finding(s) across ${new Set(findings.map((f) => `${f.file}:${f.component}`)).size} component(s)` +
      ` (${definite} definite). ${componentsAnalyzed} components analyzed, ${skipped.length} skipped.`,
  );
}

process.exit(findings.some((f) => !f.lowConfidence) ? 1 : 0);
