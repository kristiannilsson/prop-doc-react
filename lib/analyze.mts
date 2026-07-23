import path from 'node:path';
import { Project, ts } from 'ts-morph';
import { collectComponents, markPublicComponents } from './analyzer/collect-components.mjs';
import { collectUsages } from './analyzer/collect-usages.mjs';
import {
  ALL_FINDING_KINDS,
  DEFAULT_MIN_SITES,
  FINDING_SEVERITY,
  buildFindings,
} from './analyzer/build-findings.mjs';
import type { AnalyzeResult, FindingKind } from './analyzer/types.mjs';

export const TEST_FILE_RE =
  /(\.(test|spec|stories|story)\.[jt]sx?$)|([\\/](__tests__|__mocks__|__stories__|tests?|fixtures|testing)[\\/])/;

export { ALL_FINDING_KINDS, DEFAULT_MIN_SITES, FINDING_SEVERITY };
export { FIXABLE_KINDS, applyFixes, planFixes } from './fixer.mjs';
export type { AppliedEdit, FixPlan } from './fixer.mjs';
export type {
  AnalyzeResult,
  Finding,
  FindingKind,
  FindingSeverity,
  FixEdit,
  SkippedComponent,
  TextSpan,
} from './analyzer/types.mjs';

export interface AnalyzeOptions {
  includeTestComponents?: boolean;
  rules?: FindingKind[];
  minSites?: number;
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
  const initialPaths = Array.isArray(tsconfigPath) ? tsconfigPath : [tsconfigPath];
  if (initialPaths.length === 0) throw new Error('At least one tsconfig path is required.');

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

  // Referenced projects' sources join as root files of one merged program —
  // deliberately not as projectReferences, which would hide them behind
  // (possibly unbuilt) declaration outputs and drop them from the program.
  const rootNames = [...new Set(configs.flatMap((c) => c.parsed.fileNames))];
  const project = new Project({ compilerOptions: configs[0].parsed.options });
  for (const rootName of rootNames) project.addSourceFileAtPath(rootName);
  const program = project.getProgram().compilerObject;
  const checker = project.getTypeChecker().compilerObject;
  const isProjectFile = (sf: ts.SourceFile): boolean =>
    !sf.isDeclarationFile && !sf.fileName.includes('node_modules');
  // Test files are classified by their path *within* the nearest project, so
  // a repo living under a /test/ or /fixtures/ directory isn't misclassified.
  const configDirs = configs.map((c) => path.dirname(c.path)).sort((a, b) => b.length - a.length);
  const isTestFile = (fileName: string): boolean => {
    const normalized = normPath(fileName);
    const dir = configDirs.find((d) => normalized.startsWith(`${normPath(d)}/`)) ?? configDirs[0];
    return TEST_FILE_RE.test(path.relative(dir, fileName));
  };

  const { components, componentsByDecl, componentNames } = collectComponents({
    program,
    isProjectFile,
  });

  if (!assumeInternal) {
    markPublicComponents({ configDirs, program, checker, componentsByDecl });
  }

  collectUsages({
    program,
    checker,
    componentsByDecl,
    componentNames,
    isProjectFile,
    isTestFile,
  });

  const { findings, skipped } = buildFindings({
    components,
    checker,
    isProjectFile,
    isTestFile,
    includeTestComponents,
    enabledRules: rules,
    minSites,
  });

  return { findings, skipped, componentsAnalyzed: components.length };
}
