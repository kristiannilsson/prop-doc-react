import type ts from 'typescript';

export type TsApi = typeof import('typescript');

export type FindingKind =
  | 'never'
  | 'tests-only'
  | 'always'
  | 'boolean-never-true'
  | 'boolean-never-false'
  | 'union-variant-never';

export type LiteralValue = string | number | boolean;

export interface PassStats {
  files: Set<string>;
  nonTestSites: Set<string>;
  trueCount: number;
  falseCount: number;
  literalValues: Set<string>;
  unknownValueInNonTest: boolean;
}

export interface OptionalPropMeta {
  name: string;
  isBoolean: boolean;
  unionVariants: string[];
}

export interface ComponentRecord {
  name: string;
  fnNode: ts.FunctionLikeDeclaration;
  sourceFile: ts.SourceFile;
  renderSites: number;
  renderSitesNonTest: number;
  passed: Map<string, PassStats>;
  opaqueSpreadFiles: Set<string>;
  indirectRefFiles: Set<string>;
}

export interface FindingBase {
  component: string;
  file: string;
  prop: string;
  renderSites: number;
  lowConfidence: boolean;
}

export interface Finding extends FindingBase {
  kind: FindingKind;
  testFiles?: string[];
  nonTestRenderSites?: number;
  missingVariants?: string[];
  seenVariants?: string[];
}

export interface SkippedComponent {
  component: string;
  file: string;
  spreadIn: string[];
}

export interface AnalyzeResult {
  findings: Finding[];
  skipped: SkippedComponent[];
  componentsAnalyzed: number;
}
