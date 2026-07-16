import type ts from 'typescript';

export type FindingKind =
  | 'never'
  | 'tests-only'
  | 'always'
  | 'union-variant-never'
  | 'unconsumed'
  | 'callback-never-invoked'
  | 'same-literal'
  | 'passed-equals-default'
  | 'type-wider-than-usage';

export type FindingSeverity = 'definite' | 'advisory';

export type LiteralValue = string | number | boolean;

// Type-tagged so boolean true, string "true", and 1 vs "1" never collide.
export function literalKey(value: LiteralValue): string {
  return `${typeof value}:${String(value)}`;
}

export interface TextSpan {
  file: string;
  start: number;
  end: number;
}

export interface FixEdit extends TextSpan {
  newText: string;
}

export interface PassStats {
  files: Set<string>;
  nonTestSites: Set<string>;
  literalValues: Set<string>;
  unknownValueInNonTest: boolean;
  possiblyUndefinedInNonTest: boolean;
  unknownValueInTest: boolean;
  literalAttrSpans: Map<string, TextSpan[]>;
  passedAttrCount: number;
  deletableAttrSpans: TextSpan[];
  passedViaNonAttribute: boolean;
}

export interface UnionVariant {
  key: string;
  label: string;
}

export interface OwnPropMeta {
  name: string;
  optional: boolean;
  isBoolean: boolean;
  isCallable: boolean;
  isWideStringOrNumber: boolean;
  unionVariants: UnionVariant[];
  suppressed: 'all' | Set<FindingKind> | undefined;
  declNodeSpan?: TextSpan;
  typeNodeSpan?: TextSpan;
  typeNodeIsWideKeyword?: boolean;
  unionMemberNodes?: { key: string | undefined; text: string }[];
}

export interface BodyUsage {
  opaque: boolean;
  consumed: Set<string>;
  defaulted: Map<string, string | undefined>;
  restRemainders: Set<string>[];
  defaultTargets: Map<string, TextSpan>;
  bindingElementSpans: Map<string, TextSpan | 'multiple'>;
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
  publicApi: boolean;
}

export interface FindingBase {
  component: string;
  file: string;
  prop: string;
  renderSites: number;
  lowConfidence: boolean;
  publicApi: boolean;
}

export interface Finding extends FindingBase {
  kind: FindingKind;
  severity: FindingSeverity;
  testFiles?: string[];
  nonTestRenderSites?: number;
  missingVariants?: string[];
  seenVariants?: string[];
  literalValue?: string;
  observedValues?: string[];
  fix?: FixEdit[];
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
