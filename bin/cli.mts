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
  let currentFile: string | undefined;
  let currentComponent: string | undefined;

  for (const finding of findings) {
    if (rel(finding.file) !== currentFile) {
      currentFile = rel(finding.file);
      currentComponent = undefined;
      console.log(`\n${currentFile}`);
    }
    if (finding.component !== currentComponent) {
      currentComponent = finding.component;
      const confidence = finding.lowConfidence ? ' [low confidence: also referenced as a value]' : '';
      console.log(`  <${finding.component}> — ${finding.renderSites} render site(s)${confidence}`);
    }
    console.log(`    ${finding.prop.padEnd(28)} ${findingStatus(finding)}`);
  }

  if (verbose && skipped.length > 0) {
    console.log('\nSkipped (untyped/index-signature spread could pass anything):');
    for (const entry of skipped) console.log(`  <${entry.component}> in ${rel(entry.file)}`);
  }

  const definite = findings.filter((f) => !f.lowConfidence).length;
  console.log(
    `\n${findings.length} finding(s) across ${new Set(findings.map((f) => `${f.file}:${f.component}`)).size} component(s)` +
      ` (${definite} definite). ${componentsAnalyzed} components analyzed, ${skipped.length} skipped.`,
  );
}

process.exit(findings.some((f) => !f.lowConfidence) ? 1 : 0);
