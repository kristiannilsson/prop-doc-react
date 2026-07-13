import type ts from 'typescript';
import type {
  ComponentRecord,
  Finding,
  OptionalPropMeta,
  SkippedComponent,
  TsApi,
} from './types.mjs';
import { TEST_FILE_RE } from './constants.mjs';

interface BuildFindingsArgs {
  components: ComponentRecord[];
  checker: ts.TypeChecker;
  isProjectFile: (sf: ts.SourceFile) => boolean;
  includeTestComponents: boolean;
  ts: TsApi;
}

function isBooleanLike(type: ts.Type, tsApi: TsApi): boolean {
  if (type.flags & tsApi.TypeFlags.BooleanLike) return true;
  if (!type.isUnion()) return false;
  const relevant = type.types.filter(
    (t) => (t.flags & (tsApi.TypeFlags.Undefined | tsApi.TypeFlags.Null)) === 0,
  );
  return relevant.length > 0 && relevant.every((t) => (t.flags & tsApi.TypeFlags.BooleanLike) !== 0);
}

function unionLiteralVariants(type: ts.Type, tsApi: TsApi): string[] {
  if (!type.isUnion()) return [];
  const values: string[] = [];
  const relevant = type.types.filter(
    (t) => (t.flags & (tsApi.TypeFlags.Undefined | tsApi.TypeFlags.Null)) === 0,
  );
  for (const member of relevant) {
    if (member.isStringLiteral()) values.push(member.value);
    else if (member.isNumberLiteral()) values.push(String(member.value));
    else return [];
  }
  return [...new Set(values)].sort();
}

function optionalOwnProps(
  component: ComponentRecord,
  checker: ts.TypeChecker,
  isProjectFile: (sf: ts.SourceFile) => boolean,
  tsApi: TsApi,
): OptionalPropMeta[] {
  const param = component.fnNode.parameters[0];
  if (!param) return [];
  const type = checker.getTypeAtLocation(param);
  const result: OptionalPropMeta[] = [];

  for (const prop of type.getProperties()) {
    if (!(prop.flags & tsApi.SymbolFlags.Optional)) continue;
    const declaredInProject = (prop.declarations ?? []).some((d) => isProjectFile(d.getSourceFile()));
    if (!declaredInProject) continue;

    const propType = checker.getTypeOfSymbolAtLocation(prop, param);
    result.push({
      name: prop.name,
      isBoolean: isBooleanLike(propType, tsApi),
      unionVariants: unionLiteralVariants(propType, tsApi),
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
  includeTestComponents,
  ts: tsApi,
}: BuildFindingsArgs): { findings: Finding[]; skipped: SkippedComponent[] } {
  const findings: Finding[] = [];
  const skipped: SkippedComponent[] = [];

  for (const component of components) {
    if (component.renderSites === 0) continue;
    if (!includeTestComponents && TEST_FILE_RE.test(component.sourceFile.fileName)) continue;

    if (component.opaqueSpreadFiles.size > 0) {
      skipped.push({
        component: component.name,
        file: component.sourceFile.fileName,
        spreadIn: [...component.opaqueSpreadFiles].sort(),
      });
      continue;
    }

    const lowConfidence = component.indirectRefFiles.size > 0;
    for (const prop of optionalOwnProps(component, checker, isProjectFile, tsApi)) {
      const passedStats = component.passed.get(prop.name);
      const base = {
        component: component.name,
        file: component.sourceFile.fileName,
        prop: prop.name,
        renderSites: component.renderSites,
        lowConfidence,
      };

      if (!passedStats) {
        findings.push({ ...base, kind: 'never' });
        continue;
      }

      if ([...passedStats.files].every((f) => TEST_FILE_RE.test(f))) {
        findings.push({ ...base, kind: 'tests-only', testFiles: [...passedStats.files].sort() });
      }

      if (
        component.renderSitesNonTest > 0 &&
        passedStats.nonTestSites.size === component.renderSitesNonTest
      ) {
        findings.push({
          ...base,
          kind: 'always',
          nonTestRenderSites: component.renderSitesNonTest,
        });
      }

      if (prop.isBoolean && passedStats.nonTestSites.size > 0 && !passedStats.unknownValueInNonTest) {
        if (passedStats.trueCount > 0 && passedStats.falseCount === 0) {
          findings.push({ ...base, kind: 'boolean-never-false' });
        }
        if (passedStats.falseCount > 0 && passedStats.trueCount === 0) {
          findings.push({ ...base, kind: 'boolean-never-true' });
        }
      }

      if (
        prop.unionVariants.length > 1 &&
        passedStats.nonTestSites.size > 0 &&
        !passedStats.unknownValueInNonTest
      ) {
        const seen = prop.unionVariants.filter((v) => passedStats.literalValues.has(v));
        const missing = prop.unionVariants.filter((v) => !passedStats.literalValues.has(v));
        if (missing.length > 0) {
          findings.push({
            ...base,
            kind: 'union-variant-never',
            seenVariants: seen,
            missingVariants: missing,
          });
        }
      }
    }
  }

  findings.sort(compareFindingsByLocation);
  skipped.sort(compareFindingsByLocation);
  return { findings, skipped };
}
