import fs from 'node:fs';
import path from 'node:path';
import type { Finding } from './analyzer/types.mjs';

export const DEFAULT_BASELINE_PATH = '.prop-doc-baseline.json';
const BASELINE_VERSION = 1;

/** A baseline problem the caller should surface as a usage error. */
export class BaselineError extends Error {}

interface BaselineEntry {
  file: string;
  component: string;
  prop: string;
  kind: string;
}

// Baseline entries store paths relative to the baseline file so the file can
// be committed and used regardless of the invocation directory.
function entryFor(finding: Finding, baselineDir: string): BaselineEntry {
  return {
    file: path.relative(baselineDir, finding.file).replaceAll('\\', '/'),
    component: finding.component,
    prop: finding.prop,
    kind: finding.kind,
  };
}

function keyOf(entry: BaselineEntry): string {
  return [entry.file, entry.component, entry.prop, entry.kind].join('|');
}

export function writeBaseline(baselinePath: string, findings: Finding[]): { resolvedPath: string; count: number } {
  const resolvedPath = path.resolve(baselinePath);
  const baselineDir = path.dirname(resolvedPath);
  const entries = findings.map((f) => entryFor(f, baselineDir));
  try {
    fs.writeFileSync(
      resolvedPath,
      `${JSON.stringify({ version: BASELINE_VERSION, findings: entries }, null, 2)}\n`,
    );
  } catch (error) {
    throw new BaselineError(
      `Could not write baseline file ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { resolvedPath, count: entries.length };
}

/** Load a baseline and return a matcher telling whether a finding is recorded in it. */
export function loadBaseline(baselinePath: string): (finding: Finding) => boolean {
  const resolvedPath = path.resolve(baselinePath);
  const baselineDir = path.dirname(resolvedPath);

  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, 'utf8');
  } catch {
    throw new BaselineError(
      `Could not read baseline file: ${baselinePath} (create one with --write-baseline)`,
    );
  }
  let parsed: { version?: number; findings?: BaselineEntry[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BaselineError(`Baseline file is not valid JSON: ${baselinePath}`);
  }
  if (parsed.version !== BASELINE_VERSION || !Array.isArray(parsed.findings)) {
    throw new BaselineError(
      `Unsupported baseline file format in ${baselinePath}; regenerate with --write-baseline`,
    );
  }

  const recorded = new Set(parsed.findings.map(keyOf));
  return (finding) => recorded.has(keyOf(entryFor(finding, baselineDir)));
}
