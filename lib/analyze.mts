import path from 'node:path';
import ts from 'typescript';
import { collectComponents } from './analyzer/collect-components.mjs';
import { collectUsages } from './analyzer/collect-usages.mjs';
import { buildFindings } from './analyzer/build-findings.mjs';
import { TEST_FILE_RE } from './analyzer/constants.mjs';
import type { AnalyzeResult } from './analyzer/types.mjs';

export { TEST_FILE_RE };

export interface AnalyzeOptions {
  includeTestComponents?: boolean;
}

export function analyzeProject(
  tsconfigPath: string,
  { includeTestComponents = false }: AnalyzeOptions = {},
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
    ts,
  });

  const { findings, skipped } = buildFindings({
    components,
    checker,
    isProjectFile,
    includeTestComponents,
    ts,
  });

  return { findings, skipped, componentsAnalyzed: components.length };
}
