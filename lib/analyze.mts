import path from 'node:path';
import ts from 'typescript';
import { collectComponents } from './analyzer/collect-components.mjs';
import { collectUsages } from './analyzer/collect-usages.mjs';
import { markPublicComponents } from './analyzer/public-api.mjs';
import { ALL_FINDING_KINDS, DEFAULT_MIN_SITES, FINDING_SEVERITY, buildFindings } from './analyzer/build-findings.mjs';
import { TEST_FILE_RE } from './analyzer/constants.mjs';
import type { AnalyzeResult, FindingKind } from './analyzer/types.mjs';

export { ALL_FINDING_KINDS, DEFAULT_MIN_SITES, FINDING_SEVERITY, TEST_FILE_RE };
export type {
  AnalyzeResult,
  Finding,
  FindingKind,
  FindingSeverity,
  SkippedComponent,
} from './analyzer/types.mjs';

export interface AnalyzeOptions {
  includeTestComponents?: boolean;
  /** Only run these rules; defaults to all. */
  rules?: FindingKind[];
  /** Minimum non-test site count before statistical rules (always, boolean one-sided, union variants) fire. */
  minSites?: number;
  /** Skip public-API detection: treat every component as having no consumers outside this program. */
  assumeInternal?: boolean;
}

function parseConfig(configPath: string): ts.ParsedCommandLine {
  let configError: Error | undefined;
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        configError = new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  if (configError || !parsed) {
    throw configError ?? new Error(`Could not parse ${configPath}`);
  }
  return parsed;
}

const normPath = (p: string): string => p.replaceAll('\\', '/').toLowerCase();

export function analyzeProject(
  tsconfigPath: string | string[],
  { includeTestComponents = false, rules, minSites, assumeInternal = false }: AnalyzeOptions = {},
): AnalyzeResult {
  if (typeof ts.createProgram !== 'function') {
    throw new Error(
      `The resolved 'typescript' package (${ts.version ?? 'unknown'}) has no compiler API; TypeScript 5.x is required.`,
    );
  }

  const initialPaths = Array.isArray(tsconfigPath) ? tsconfigPath : [tsconfigPath];
  if (initialPaths.length === 0) throw new Error('At least one tsconfig path is required.');

  // Load every given config plus, recursively, its project references, so
  // render sites across monorepo package boundaries land in one program.
  const configs: { path: string; parsed: ts.ParsedCommandLine }[] = [];
  const queue = initialPaths.map((p) => path.resolve(p));
  const visited = new Set<string>();
  while (queue.length > 0) {
    const configPath = queue.shift() as string;
    if (visited.has(normPath(configPath))) continue;
    visited.add(normPath(configPath));
    const parsed = parseConfig(configPath);
    configs.push({ path: configPath, parsed });
    for (const ref of parsed.projectReferences ?? []) {
      queue.push(ts.resolveProjectReferencePath(ref));
    }
  }

  const rootNames = [...new Set(configs.flatMap((c) => c.parsed.fileNames))];
  // One merged program; the first config's compiler options govern. The
  // referenced projects' SOURCES are included as root files directly —
  // deliberately not passed as projectReferences, which would make TS treat
  // them as external inputs behind their (possibly unbuilt) declaration
  // outputs and drop them from the program.
  const program = ts.createProgram({
    rootNames,
    options: configs[0].parsed.options,
  });
  const checker = program.getTypeChecker();
  const isProjectFile = (sf: ts.SourceFile): boolean =>
    !sf.isDeclarationFile && !sf.fileName.includes('node_modules');
  // Classify test files by their path *within* the nearest project, so a repo
  // that itself lives under a /test/ or /fixtures/ directory isn't
  // misclassified.
  const configDirs = configs.map((c) => path.dirname(c.path)).sort((a, b) => b.length - a.length);
  const isTestFile = (fileName: string): boolean => {
    const normalized = normPath(fileName);
    const dir = configDirs.find((d) => normalized.startsWith(`${normPath(d)}/`)) ?? configDirs[0];
    return TEST_FILE_RE.test(path.relative(dir, fileName));
  };

  const { components, componentsByDecl, componentNames } = collectComponents({
    program,
    isProjectFile,
    ts,
  });

  if (!assumeInternal) {
    markPublicComponents({ configDirs, program, checker, componentsByDecl, ts });
  }

  collectUsages({
    program,
    checker,
    componentsByDecl,
    componentNames,
    isProjectFile,
    isTestFile,
    ts,
  });

  const { findings, skipped } = buildFindings({
    components,
    checker,
    isProjectFile,
    isTestFile,
    includeTestComponents,
    enabledRules: rules,
    minSites,
    ts,
  });

  return { findings, skipped, componentsAnalyzed: components.length };
}
