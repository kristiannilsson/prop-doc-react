import type ts from 'typescript';

export type TsApi = typeof import('typescript');

export type FindingKind =
  | 'never'
  | 'tests-only'
  | 'always'
  | 'boolean-never-true'
  | 'boolean-never-false'
  | 'union-variant-never'
  | 'unconsumed'
  | 'callback-never-invoked'
  | 'default-never-used';

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
  /** Some non-test site may pass `undefined` (per the value's type), so a destructuring default could still be exercised. */
  possiblyUndefinedInNonTest: boolean;
}

/** A literal member of a union prop type: `key` is type-tagged for matching, `label` is for display. */
export interface UnionVariant {
  key: string;
  label: string;
}

export interface OwnPropMeta {
  name: string;
  optional: boolean;
  isBoolean: boolean;
  /** The prop's (non-nullable) type is callable. */
  isCallable: boolean;
  unionVariants: UnionVariant[];
  /** Rules suppressed via `prop-doc-ignore` comments on the prop declaration. */
  suppressed: 'all' | Set<FindingKind> | undefined;
}

/** How a component's body uses its props, from destructuring and `props.x` access. */
export interface BodyUsage {
  /** The props object escapes whole (aliased, spread, passed along); nothing can be concluded. */
  opaque: boolean;
  /** Props read via a referenced destructured binding or a `props.x` access. */
  consumed: Set<string>;
  /** Props with a destructuring default value. */
  defaulted: Set<string>;
  /**
   * For each referenced `...rest` binding, the prop names its pattern picks off;
   * every prop NOT in the set is consumed (forwarded) through that rest.
   */
  restRemainders: Set<string>[];
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
