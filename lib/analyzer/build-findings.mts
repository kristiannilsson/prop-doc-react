import type ts from 'typescript';
import type {
  BodyUsage,
  ComponentRecord,
  Finding,
  FindingKind,
  FindingSeverity,
  FixEdit,
  OwnPropMeta,
  PassStats,
  SkippedComponent,
  TextSpan,
  TsApi,
  UnionVariant,
} from './types.mjs';
import { analyzeBodyUsage, isConsumed } from './analyze-body.mjs';
import { literalKey } from './constants.mjs';

export const FINDING_SEVERITY: Record<FindingKind, FindingSeverity> = {
  never: 'definite',
  'tests-only': 'definite',
  unconsumed: 'definite',
  'callback-never-invoked': 'definite',
  always: 'advisory',
  'boolean-never-true': 'advisory',
  'boolean-never-false': 'advisory',
  'union-variant-never': 'advisory',
  'default-never-used': 'advisory',
  'same-literal': 'advisory',
  'passed-equals-default': 'advisory',
  'type-wider-than-usage': 'advisory',
};

/** Render a type-tagged literal key for humans: strings quoted, the rest raw. */
function displayLiteral(key: string): string {
  return key.startsWith('string:')
    ? JSON.stringify(key.slice('string:'.length))
    : key.slice(key.indexOf(':') + 1);
}

/** Whether a type-tagged literal key can be rendered back into source text. */
function isSourceableKey(key: string): boolean {
  return key.startsWith('string:') || key.startsWith('number:');
}

/** Render a type-tagged literal key as source text: strings single-quoted, numbers raw. */
function sourceTextOfKey(key: string): string {
  if (key.startsWith('number:')) return key.slice('number:'.length);
  const value = key.slice('string:'.length);
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

export const ALL_FINDING_KINDS = Object.keys(FINDING_SEVERITY) as FindingKind[];

export const DEFAULT_MIN_SITES = 3;

interface BuildFindingsArgs {
  components: ComponentRecord[];
  checker: ts.TypeChecker;
  isProjectFile: (sf: ts.SourceFile) => boolean;
  isTestFile: (fileName: string) => boolean;
  includeTestComponents: boolean;
  enabledRules?: FindingKind[];
  minSites?: number;
  ts: TsApi;
}

function nonNullableMembers(type: ts.UnionType, tsApi: TsApi): ts.Type[] {
  return type.types.filter(
    (t) => (t.flags & (tsApi.TypeFlags.Undefined | tsApi.TypeFlags.Null)) === 0,
  );
}

function isBooleanLike(type: ts.Type, tsApi: TsApi): boolean {
  if (type.flags & tsApi.TypeFlags.BooleanLike) return true;
  if (!type.isUnion()) return false;
  const relevant = nonNullableMembers(type, tsApi);
  return relevant.length > 0 && relevant.every((t) => (t.flags & tsApi.TypeFlags.BooleanLike) !== 0);
}

function unionLiteralVariants(type: ts.Type, tsApi: TsApi): UnionVariant[] {
  if (!type.isUnion()) return [];
  const variants = new Map<string, UnionVariant>();
  for (const member of nonNullableMembers(type, tsApi)) {
    let value: string | number;
    if (member.isStringLiteral()) value = member.value;
    else if (member.isNumberLiteral()) value = member.value;
    else return [];
    variants.set(literalKey(value), { key: literalKey(value), label: String(value) });
  }
  return [...variants.values()].sort((a, b) => a.label.localeCompare(b.label));
}

const IGNORE_MARKER_RE = /\bprop-doc-ignore\b(.*)/;

function suppressionFromComment(commentText: string): 'all' | FindingKind[] | undefined {
  const match = IGNORE_MARKER_RE.exec(commentText);
  if (!match) return undefined;
  const names = match[1]
    .replace(/\*\/\s*$/, '')
    .split(/[,\s]+/)
    .filter(Boolean);
  const kinds = names.filter((n): n is FindingKind => (ALL_FINDING_KINDS as string[]).includes(n));
  return kinds.length > 0 ? kinds : 'all';
}

// A `prop-doc-ignore` comment on its own line above the prop declaration, or
// trailing on the same line, suppresses all rules for that prop; naming rules
// (`prop-doc-ignore never, always`) suppresses only those.
function propSuppression(
  prop: ts.Symbol,
  isProjectFile: (sf: ts.SourceFile) => boolean,
  tsApi: TsApi,
): 'all' | Set<FindingKind> | undefined {
  const kinds = new Set<FindingKind>();
  for (const decl of prop.declarations ?? []) {
    const sf = decl.getSourceFile();
    if (!isProjectFile(sf)) continue;
    const text = sf.text;
    const fullStart = decl.getFullStart();
    // Leading trivia also contains the previous line's trailing comment; only
    // comments on lines below the previous token count as leading here.
    const prevTokenLine = sf.getLineAndCharacterOfPosition(fullStart).line;
    const ranges = [
      ...(tsApi.getLeadingCommentRanges(text, fullStart) ?? []).filter(
        (r) => sf.getLineAndCharacterOfPosition(r.pos).line > prevTokenLine,
      ),
      ...(tsApi.getTrailingCommentRanges(text, decl.getEnd()) ?? []),
    ];
    for (const range of ranges) {
      const suppression = suppressionFromComment(text.slice(range.pos, range.end));
      if (suppression === 'all') return 'all';
      for (const kind of suppression ?? []) kinds.add(kind);
    }
  }
  return kinds.size > 0 ? kinds : undefined;
}

/** Type-tagged literal key of a union member type node, or undefined for non-literal members. */
function unionMemberNodeKey(node: ts.TypeNode, tsApi: TsApi): string | undefined {
  if (!tsApi.isLiteralTypeNode(node)) return undefined;
  const literal = node.literal;
  if (tsApi.isStringLiteral(literal)) return literalKey(literal.text);
  if (tsApi.isNumericLiteral(literal)) return literalKey(Number(literal.text));
  if (
    tsApi.isPrefixUnaryExpression(literal) &&
    literal.operator === tsApi.SyntaxKind.MinusToken &&
    tsApi.isNumericLiteral(literal.operand)
  ) {
    return literalKey(-Number(literal.operand.text));
  }
  return undefined;
}

// The span deletes the declaration's whole line when it stands alone: the
// preceding newline and indentation, the node (separator included), and any
// trailing line comment.
function declarationDeletionSpan(decl: ts.Declaration, sf: ts.SourceFile): TextSpan {
  const text = sf.text;
  let start = decl.getStart(sf);
  while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start -= 1;
  if (start > 0 && text[start - 1] === '\n') {
    start -= 1;
    if (start > 0 && text[start - 1] === '\r') start -= 1;
  }
  let end = decl.getEnd();
  if (text[end] === ';' || text[end] === ',') end += 1;
  let probe = end;
  while (probe < text.length && (text[probe] === ' ' || text[probe] === '\t')) probe += 1;
  if (text.startsWith('//', probe)) {
    while (probe < text.length && text[probe] !== '\n' && text[probe] !== '\r') probe += 1;
    end = probe;
  }
  return { file: sf.fileName, start, end };
}

/** Declaration-side fix targets, when the prop is one plain property signature in project code. */
function declarationNodeInfo(
  prop: ts.Symbol,
  tsApi: TsApi,
): Pick<OwnPropMeta, 'declNodeSpan' | 'typeNodeSpan' | 'typeNodeIsWideKeyword' | 'unionMemberNodes'> {
  const decls = prop.declarations ?? [];
  const decl = decls.length === 1 ? decls[0] : undefined;
  if (!decl || !(tsApi.isPropertySignature(decl) || tsApi.isPropertyDeclaration(decl)) || !decl.type) {
    return {};
  }
  const sf = decl.getSourceFile();
  const typeNode = decl.type;
  return {
    declNodeSpan: declarationDeletionSpan(decl, sf),
    typeNodeSpan: { file: sf.fileName, start: typeNode.getStart(sf), end: typeNode.getEnd() },
    typeNodeIsWideKeyword:
      typeNode.kind === tsApi.SyntaxKind.StringKeyword || typeNode.kind === tsApi.SyntaxKind.NumberKeyword,
    unionMemberNodes: tsApi.isUnionTypeNode(typeNode)
      ? typeNode.types.map((t) => ({ key: unionMemberNodeKey(t, tsApi), text: t.getText(sf) }))
      : undefined,
  };
}

function ownProps(
  component: ComponentRecord,
  checker: ts.TypeChecker,
  isProjectFile: (sf: ts.SourceFile) => boolean,
  tsApi: TsApi,
): OwnPropMeta[] {
  const param = component.fnNode.parameters[0];
  if (!param) return [];
  const type = checker.getTypeAtLocation(param);
  const result: OwnPropMeta[] = [];

  for (const prop of type.getProperties()) {
    const declaredInProject = (prop.declarations ?? []).some((d) => isProjectFile(d.getSourceFile()));
    if (!declaredInProject) continue;

    const propType = checker.getTypeOfSymbolAtLocation(prop, param);
    const nonNullable = checker.getNonNullableType(propType);
    const wideFlags = tsApi.TypeFlags.String | tsApi.TypeFlags.Number;
    result.push({
      name: prop.name,
      optional: (prop.flags & tsApi.SymbolFlags.Optional) !== 0,
      isBoolean: isBooleanLike(propType, tsApi),
      isCallable: nonNullable.getCallSignatures().length > 0,
      isWideStringOrNumber:
        (nonNullable.flags & wideFlags) !== 0 ||
        (nonNullable.isUnion() && nonNullable.types.every((t) => (t.flags & wideFlags) !== 0)),
      unionVariants: unionLiteralVariants(propType, tsApi),
      suppressed: propSuppression(prop, isProjectFile, tsApi),
      ...declarationNodeInfo(prop, tsApi),
    });
  }

  return result;
}

/**
 * same-literal fix: fold the literal into the destructuring default, then
 * delete the attribute at every callsite. Behavior-preserving only when EVERY
 * render site (test files included) verifiably passes that exact literal —
 * a site omitting the prop would observe the new default, and non-literal
 * values can't be verified.
 */
function sameLiteralFix(
  component: ComponentRecord,
  prop: OwnPropMeta,
  key: string,
  spans: TextSpan[] | undefined,
  defaultTarget: TextSpan | undefined,
): FixEdit[] | undefined {
  if (!prop.optional || defaultTarget === undefined || !isSourceableKey(key)) return undefined;
  if (!spans || spans.length !== component.renderSites) return undefined;
  const literalText = sourceTextOfKey(key);
  const defaultEdit: FixEdit =
    defaultTarget.start === defaultTarget.end
      ? { ...defaultTarget, newText: ` = ${literalText}` } // insert after the binding name
      : { ...defaultTarget, newText: literalText }; // replace the (never-exercised) default
  return [defaultEdit, ...spans.map((s) => ({ ...s, newText: '' }))];
}

/** type-wider-than-usage fix: replace the bare `string`/`number` keyword with the observed-literal union. */
function typeWiderFix(prop: OwnPropMeta, stats: PassStats): FixEdit[] | undefined {
  // A test-file site passing a non-literal value would no longer typecheck
  // against the narrowed union, so the fix requires literals everywhere.
  if (!prop.typeNodeSpan || !prop.typeNodeIsWideKeyword || stats.unknownValueInTest) return undefined;
  const keys = [...stats.literalAttrSpans.keys()];
  if (keys.length === 0 || !keys.every(isSourceableKey)) return undefined;
  const texts = keys.map(sourceTextOfKey).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return [{ ...prop.typeNodeSpan, newText: texts.join(' | ') }];
}

/** union-variant-never fix: rewrite the direct union type node keeping only members some site passes. */
function unionVariantFix(prop: OwnPropMeta, stats: PassStats): FixEdit[] | undefined {
  if (!prop.typeNodeSpan || !prop.unionMemberNodes || stats.unknownValueInTest) return undefined;
  // Only variants that no site anywhere (test files included) passes may go;
  // non-literal members (e.g. an explicit `undefined`) are always kept.
  const kept = prop.unionMemberNodes.filter((m) => m.key === undefined || stats.literalAttrSpans.has(m.key));
  if (kept.length === prop.unionMemberNodes.length || !kept.some((m) => m.key !== undefined)) return undefined;
  return [{ ...prop.typeNodeSpan, newText: kept.map((m) => m.text).join(' | ') }];
}

/**
 * Whole-prop removal (never / unconsumed / callback-never-invoked): delete
 * the declaration line, the (unreferenced) destructuring binding, and every
 * callsite attribute. Only when the body verifiably doesn't consume the prop
 * and every pass is an attribute whose initializer is side-effect-free —
 * a spread, JSX nesting, or a call-expression value blocks the fix.
 */
function removePropFix(
  prop: OwnPropMeta,
  stats: PassStats | undefined,
  usage: BodyUsage,
): FixEdit[] | undefined {
  if (prop.name === 'children' || usage.opaque || !prop.declNodeSpan) return undefined;
  const binding = usage.bindingElementSpans.get(prop.name);
  if (binding === 'multiple') return undefined;
  if (stats && (stats.passedViaNonAttribute || stats.deletableAttrSpans.length !== stats.passedAttrCount)) {
    return undefined;
  }
  const edits: FixEdit[] = [{ ...prop.declNodeSpan, newText: '' }];
  if (binding) edits.push({ ...binding, newText: '' });
  for (const span of stats?.deletableAttrSpans ?? []) edits.push({ ...span, newText: '' });
  return edits;
}

function compareFindingsByLocation(a: Finding | SkippedComponent, b: Finding | SkippedComponent): number {
  const byFile = a.file.localeCompare(b.file);
  if (byFile !== 0) return byFile;
  const byComponent = a.component.localeCompare(b.component);
  if (byComponent !== 0) return byComponent;
  return ('prop' in a ? a.prop : '').localeCompare('prop' in b ? b.prop : '');
}

export function buildFindings({
  components,
  checker,
  isProjectFile,
  isTestFile,
  includeTestComponents,
  enabledRules,
  minSites = DEFAULT_MIN_SITES,
  ts: tsApi,
}: BuildFindingsArgs): { findings: Finding[]; skipped: SkippedComponent[] } {
  const findings: Finding[] = [];
  const skipped: SkippedComponent[] = [];
  const enabled = enabledRules ? new Set(enabledRules) : undefined;
  const ruleOn = (kind: FindingKind): boolean => !enabled || enabled.has(kind);
  const push = (finding: Omit<Finding, 'severity'>): void => {
    findings.push({ ...finding, severity: FINDING_SEVERITY[finding.kind] });
  };

  for (const component of components) {
    if (component.renderSites === 0) continue;
    if (!includeTestComponents && isTestFile(component.sourceFile.fileName)) continue;

    if (component.opaqueSpreadFiles.size > 0) {
      skipped.push({
        component: component.name,
        file: component.sourceFile.fileName,
        spreadIn: [...component.opaqueSpreadFiles].sort(),
      });
      continue;
    }

    const lowConfidence = component.indirectRefFiles.size > 0;
    const usage = analyzeBodyUsage(component, checker, tsApi);
    for (const prop of ownProps(component, checker, isProjectFile, tsApi)) {
      if (prop.suppressed === 'all') continue;
      const suppressed = prop.suppressed;
      const active = (kind: FindingKind): boolean => ruleOn(kind) && !suppressed?.has(kind);
      const passedStats = component.passed.get(prop.name);
      const base = {
        component: component.name,
        file: component.sourceFile.fileName,
        prop: prop.name,
        renderSites: component.renderSites,
        lowConfidence,
        publicApi: component.publicApi,
      };

      // Consumption rules look at the component body, so they apply to
      // required props too, whether or not any parent passes the prop.
      if (!isConsumed(usage, prop.name)) {
        if (prop.isCallable && passedStats) {
          if (active('callback-never-invoked')) {
            push({ ...base, kind: 'callback-never-invoked', fix: removePropFix(prop, passedStats, usage) });
          }
        } else if (active('unconsumed')) {
          push({ ...base, kind: 'unconsumed', fix: removePropFix(prop, passedStats, usage) });
        }
      }

      // Value-pattern rules apply to required props too: statistical evidence
      // needs enough sites, all with literal (or at least defined) values.
      const literalSites =
        passedStats !== undefined &&
        passedStats.nonTestSites.size >= minSites &&
        !passedStats.unknownValueInNonTest;

      // Every provided value is exactly the destructuring default: the
      // attribute is redundant at each callsite. Wins over default-never-used
      // and same-literal, which describe the same evidence less actionably.
      const defaultKey = usage.defaulted.get(prop.name);
      const equalsDefault =
        literalSites &&
        defaultKey !== undefined &&
        passedStats.literalValues.size === 1 &&
        passedStats.literalValues.has(defaultKey);
      if (equalsDefault && active('passed-equals-default')) {
        push({
          ...base,
          kind: 'passed-equals-default',
          literalValue: displayLiteral(defaultKey),
          // Only attributes whose value was verified to be this exact literal
          // have spans under this key; sites passing the default through a
          // variable stay untouched.
          fix: (passedStats.literalAttrSpans.get(defaultKey) ?? []).map((s) => ({ ...s, newText: '' })),
        });
      }

      if (
        !equalsDefault &&
        active('default-never-used') &&
        usage.defaulted.has(prop.name) &&
        passedStats &&
        component.renderSitesNonTest >= minSites &&
        passedStats.nonTestSites.size === component.renderSitesNonTest &&
        !passedStats.possiblyUndefinedInNonTest
      ) {
        push({ ...base, kind: 'default-never-used', nonTestRenderSites: component.renderSitesNonTest });
      }

      // Booleans are excluded: the one-sided boolean rules already cover them.
      if (
        !equalsDefault &&
        active('same-literal') &&
        !prop.isBoolean &&
        literalSites &&
        passedStats.literalValues.size === 1
      ) {
        const onlyKey = [...passedStats.literalValues][0];
        push({
          ...base,
          kind: 'same-literal',
          literalValue: displayLiteral(onlyKey),
          fix: sameLiteralFix(
            component,
            prop,
            onlyKey,
            passedStats.literalAttrSpans.get(onlyKey),
            usage.defaultTargets.get(prop.name),
          ),
        });
      }

      // Wide string/number props whose observed values are a small repeated
      // set want a union literal type. Needs distinct >= 2 (1 is same-literal)
      // and enough repetition that the set looks intentional.
      if (
        active('type-wider-than-usage') &&
        prop.isWideStringOrNumber &&
        !prop.isBoolean &&
        literalSites &&
        passedStats.literalValues.size >= 2 &&
        passedStats.literalValues.size <= 4 &&
        passedStats.nonTestSites.size >= Math.max(minSites, 2 * passedStats.literalValues.size)
      ) {
        push({
          ...base,
          kind: 'type-wider-than-usage',
          observedValues: [...passedStats.literalValues].map(displayLiteral).sort(),
          fix: typeWiderFix(prop, passedStats),
        });
      }

      if (
        active('union-variant-never') &&
        prop.unionVariants.length > 1 &&
        literalSites
      ) {
        const seen = prop.unionVariants.filter((v) => passedStats.literalValues.has(v.key));
        const missing = prop.unionVariants.filter((v) => !passedStats.literalValues.has(v.key));
        if (missing.length > 0) {
          push({
            ...base,
            kind: 'union-variant-never',
            seenVariants: seen.map((v) => v.label),
            missingVariants: missing.map((v) => v.label),
            fix: unionVariantFix(prop, passedStats),
          });
        }
      }

      // The remaining rules only make sense for optional props.
      if (!prop.optional) continue;

      if (!passedStats) {
        if (active('never')) {
          // Removal is only safe when the body verifiably ignores the prop;
          // a body still reading it needs a human to resolve the dead branch.
          push({
            ...base,
            kind: 'never',
            fix: isConsumed(usage, prop.name) ? undefined : removePropFix(prop, undefined, usage),
          });
        }
        continue;
      }

      if (active('tests-only') && [...passedStats.files].every((f) => isTestFile(f))) {
        push({ ...base, kind: 'tests-only', testFiles: [...passedStats.files].sort() });
      }

      // The remaining rules are statistical: their evidence is a usage pattern
      // across sites, so they only fire once enough sites back the pattern.
      // "Always passed" also requires every value's type to exclude undefined:
      // a site passing `x={maybe}` with `maybe: string | undefined` provides
      // the prop only conditionally, so it is no candidate for required.
      if (
        active('always') &&
        component.renderSitesNonTest >= minSites &&
        passedStats.nonTestSites.size === component.renderSitesNonTest &&
        !passedStats.possiblyUndefinedInNonTest
      ) {
        push({
          ...base,
          kind: 'always',
          nonTestRenderSites: component.renderSitesNonTest,
        });
      }

      if (
        prop.isBoolean &&
        passedStats.nonTestSites.size >= minSites &&
        !passedStats.unknownValueInNonTest
      ) {
        if (active('boolean-never-false') && passedStats.trueCount > 0 && passedStats.falseCount === 0) {
          push({ ...base, kind: 'boolean-never-false' });
        }
        if (active('boolean-never-true') && passedStats.falseCount > 0 && passedStats.trueCount === 0) {
          push({ ...base, kind: 'boolean-never-true' });
        }
      }
    }
  }

  findings.sort(compareFindingsByLocation);
  skipped.sort(compareFindingsByLocation);
  return { findings, skipped };
}
