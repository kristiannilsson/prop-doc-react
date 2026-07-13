import type ts from 'typescript';
import type {
  ComponentRecord,
  Finding,
  FindingKind,
  FindingSeverity,
  OwnPropMeta,
  SkippedComponent,
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
};

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
    result.push({
      name: prop.name,
      optional: (prop.flags & tsApi.SymbolFlags.Optional) !== 0,
      isBoolean: isBooleanLike(propType, tsApi),
      isCallable: checker.getNonNullableType(propType).getCallSignatures().length > 0,
      unionVariants: unionLiteralVariants(propType, tsApi),
      suppressed: propSuppression(prop, isProjectFile, tsApi),
    });
  }

  return result;
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
      };

      // Consumption rules look at the component body, so they apply to
      // required props too, whether or not any parent passes the prop.
      if (!isConsumed(usage, prop.name)) {
        if (prop.isCallable && passedStats) {
          if (active('callback-never-invoked')) push({ ...base, kind: 'callback-never-invoked' });
        } else if (active('unconsumed')) {
          push({ ...base, kind: 'unconsumed' });
        }
      }

      if (
        active('default-never-used') &&
        usage.defaulted.has(prop.name) &&
        passedStats &&
        component.renderSitesNonTest >= minSites &&
        passedStats.nonTestSites.size === component.renderSitesNonTest &&
        !passedStats.possiblyUndefinedInNonTest
      ) {
        push({ ...base, kind: 'default-never-used', nonTestRenderSites: component.renderSitesNonTest });
      }

      // The remaining rules only make sense for optional props.
      if (!prop.optional) continue;

      if (!passedStats) {
        if (active('never')) push({ ...base, kind: 'never' });
        continue;
      }

      if (active('tests-only') && [...passedStats.files].every((f) => isTestFile(f))) {
        push({ ...base, kind: 'tests-only', testFiles: [...passedStats.files].sort() });
      }

      // The remaining rules are statistical: their evidence is a usage pattern
      // across sites, so they only fire once enough sites back the pattern.
      if (
        active('always') &&
        component.renderSitesNonTest >= minSites &&
        passedStats.nonTestSites.size === component.renderSitesNonTest
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

      if (
        active('union-variant-never') &&
        prop.unionVariants.length > 1 &&
        passedStats.nonTestSites.size >= minSites &&
        !passedStats.unknownValueInNonTest
      ) {
        const seen = prop.unionVariants.filter((v) => passedStats.literalValues.has(v.key));
        const missing = prop.unionVariants.filter((v) => !passedStats.literalValues.has(v.key));
        if (missing.length > 0) {
          push({
            ...base,
            kind: 'union-variant-never',
            seenVariants: seen.map((v) => v.label),
            missingVariants: missing.map((v) => v.label),
          });
        }
      }
    }
  }

  findings.sort(compareFindingsByLocation);
  skipped.sort(compareFindingsByLocation);
  return { findings, skipped };
}
