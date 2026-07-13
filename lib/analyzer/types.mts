import type ts from 'typescript';

export type TsApi = typeof import('typescript');

export type FindingKind =
  | 'never'
  | 'tests-only'
  | 'always'
  | 'boolean-never-true'
  | 'boolean-never-false'
  | 'union-variant-never';

// 'definite' findings point at dead code; 'advisory' findings are API-design
// suggestions inferred from usage statistics. Only high-confidence definite
// findings should fail a CI gate.
export type FindingSeverity = 'definite' | 'advisory';

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
  /** Rules suppressed via `prop-doc-ignore` comments on the prop declaration. */
  suppressed: 'all' | Set<FindingKind> | undefined;
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
  severity: FindingSeverity;
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
