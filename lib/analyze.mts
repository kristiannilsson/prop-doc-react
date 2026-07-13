import path from 'node:path';
import ts from 'typescript';
import { collectComponents } from './analyzer/collect-components.mjs';
import { collectUsages } from './analyzer/collect-usages.mjs';
import { ALL_FINDING_KINDS, DEFAULT_MIN_SITES, FINDING_SEVERITY, buildFindings } from './analyzer/build-findings.mjs';
import { TEST_FILE_RE } from './analyzer/constants.mjs';
import type { AnalyzeResult, FindingKind } from './analyzer/types.mjs';

export { ALL_FINDING_KINDS, DEFAULT_MIN_SITES, FINDING_SEVERITY, TEST_FILE_RE };

export interface AnalyzeOptions {
  includeTestComponents?: boolean;
  /** Only run these rules; defaults to all. */
  rules?: FindingKind[];
  /** Minimum non-test site count before statistical rules (always, boolean one-sided, union variants) fire. */
  minSites?: number;
}

export function analyzeProject(
  tsconfigPath: string,
  { includeTestComponents = false, rules, minSites }: AnalyzeOptions = {},
): AnalyzeResult {
  if (typeof ts.createProgram !== 'function') {
    throw new Error(
      `The resolved 'typescript' package (${ts.version ?? 'unknown'}) has no compiler API; TypeScript 5.x is required.`,
    );
  }

  const configPath = path.resolve(tsconfigPath);
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

  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const checker = program.getTypeChecker();
  const isProjectFile = (sf: ts.SourceFile): boolean =>
    !sf.isDeclarationFile && !sf.fileName.includes('node_modules');
  // Classify test files by their path *within* the project, so a repo that
  // itself lives under a /test/ or /fixtures/ directory isn't misclassified.
  const configDir = path.dirname(configPath);
  const isTestFile = (fileName: string): boolean =>
    TEST_FILE_RE.test(path.relative(configDir, fileName));

  const { components, componentsByDecl, componentNames } = collectComponents({
    program,
    isProjectFile,
    ts,
  });

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
