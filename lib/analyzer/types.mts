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
  | 'default-never-used'
  | 'same-literal'
  | 'passed-equals-default'
  | 'type-wider-than-usage';

// 'definite' findings point at dead code; 'advisory' findings are API-design
// suggestions inferred from usage statistics. Only high-confidence definite
// findings should fail a CI gate.
export type FindingSeverity = 'definite' | 'advisory';

export type LiteralValue = string | number | boolean;

/** A contiguous character range in a source file. */
export interface TextSpan {
  file: string;
  start: number;
  end: number;
}

/** One mechanical text edit; empty `newText` deletes the span. Offsets are into the file's text as analyzed. */
export interface FixEdit extends TextSpan {
  newText: string;
}

export interface PassStats {
  files: Set<string>;
  nonTestSites: Set<string>;
  trueCount: number;
  falseCount: number;
  literalValues: Set<string>;
  unknownValueInNonTest: boolean;
  /** Some non-test site may pass `undefined` (per the value's type), so a destructuring default could still be exercised. */
  possiblyUndefinedInNonTest: boolean;
  /**
   * Deletion spans of literal-valued JSX attributes (leading whitespace
   * included), keyed by the value's type-tagged literal key. Unlike the
   * evidence fields above this includes test-file sites: a fix must remove
   * the attribute everywhere, not just where the evidence came from.
   */
  literalAttrSpans: Map<string, TextSpan[]>;
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
  /** The prop's (non-nullable) type is the wide `string` / `number` primitive, not a literal union. */
  isWideStringOrNumber: boolean;
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
  /**
   * Props with a destructuring default value, mapped to the default's
   * type-tagged literal key (see `literalKey`), or undefined when the
   * default isn't a literal.
   */
  defaulted: Map<string, string | undefined>;
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
  /** Exported from a package entry point: may have consumers outside this program. */
  publicApi: boolean;
}

export interface FindingBase {
  component: string;
  file: string;
  prop: string;
  renderSites: number;
  lowConfidence: boolean;
  /** The component is exported from a package entry point; the finding must not gate CI. */
  publicApi: boolean;
}

export interface Finding extends FindingBase {
  kind: FindingKind;
  severity: FindingSeverity;
  testFiles?: string[];
  nonTestRenderSites?: number;
  missingVariants?: string[];
  seenVariants?: string[];
  /** For 'same-literal' / 'passed-equals-default': the one value every parent passes, rendered for display (strings quoted). */
  literalValue?: string;
  /** For 'type-wider-than-usage': every value ever passed, rendered for display. */
  observedValues?: string[];
  /** Mechanical edits that resolve the finding; only rules with a fixer set this. */
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
