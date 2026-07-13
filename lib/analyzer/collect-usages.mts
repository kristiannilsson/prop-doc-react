import type ts from 'typescript';
import type { ComponentRecord, LiteralValue, PassStats, TsApi } from './types.mjs';
import { TEST_FILE_RE } from './constants.mjs';

interface CollectUsagesArgs {
  program: ts.Program;
  checker: ts.TypeChecker;
  componentsByDecl: Map<ts.Declaration, ComponentRecord>;
  componentNames: Set<string>;
  isProjectFile: (sf: ts.SourceFile) => boolean;
  ts: TsApi;
}

interface RecordPassedOptions {
  isTestFile: boolean;
  siteId: string;
  fromSpread?: boolean;
  literal?: LiteralValue;
  /** For non-literal values: whether the expression's type admits undefined. Defaults to true (conservative). */
  possiblyUndefined?: boolean;
}

function isJsxTagContext(identifier: ts.Identifier, tsApi: TsApi): boolean {
  const parent = identifier.parent;
  if (
    tsApi.isJsxOpeningElement(parent) ||
    tsApi.isJsxSelfClosingElement(parent) ||
    tsApi.isJsxClosingElement(parent)
  ) {
    return true;
  }
  if (tsApi.isPropertyAccessExpression(parent)) {
    const grand = parent.parent;
    return (
      tsApi.isJsxOpeningElement(grand) ||
      tsApi.isJsxSelfClosingElement(grand) ||
      tsApi.isJsxClosingElement(grand)
    );
  }
  return false;
}

function isDeclarationContext(identifier: ts.Identifier, tsApi: TsApi): boolean {
  const parent = identifier.parent;
  return (
    ((tsApi.isVariableDeclaration(parent) || tsApi.isFunctionDeclaration(parent)) &&
      parent.name === identifier) ||
    tsApi.isImportSpecifier(parent) ||
    tsApi.isExportSpecifier(parent) ||
    tsApi.isImportClause(parent) ||
    tsApi.isNamespaceImport(parent) ||
    tsApi.isExportAssignment(parent)
  );
}

function hasMeaningfulChildren(jsxElement: ts.JsxElement, tsApi: TsApi): boolean {
  return jsxElement.children.some(
    (child) => !tsApi.isJsxText(child) || child.text.trim().length > 0,
  );
}

function literalFromAttribute(attr: ts.JsxAttribute, tsApi: TsApi): LiteralValue | undefined {
  if (!attr.initializer) return true;
  if (tsApi.isStringLiteral(attr.initializer)) return attr.initializer.text;
  if (!tsApi.isJsxExpression(attr.initializer)) return undefined;
  const expr = attr.initializer.expression;
  if (!expr) return undefined;
  if (expr.kind === tsApi.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === tsApi.SyntaxKind.FalseKeyword) return false;
  if (tsApi.isStringLiteral(expr) || tsApi.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (tsApi.isNumericLiteral(expr)) return Number(expr.text);
  if (
    tsApi.isPrefixUnaryExpression(expr) &&
    (expr.operator === tsApi.SyntaxKind.MinusToken || expr.operator === tsApi.SyntaxKind.PlusToken) &&
    tsApi.isNumericLiteral(expr.operand)
  ) {
    const n = Number(expr.operand.text);
    return expr.operator === tsApi.SyntaxKind.MinusToken ? -n : n;
  }
  return undefined;
}

function typeAdmitsUndefined(type: ts.Type, tsApi: TsApi): boolean {
  const loose =
    tsApi.TypeFlags.Undefined | tsApi.TypeFlags.Void | tsApi.TypeFlags.Any | tsApi.TypeFlags.Unknown;
  if (type.flags & loose) return true;
  return type.isUnion() && type.types.some((t) => (t.flags & loose) !== 0);
}

function resolveToComponent(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  componentsByDecl: Map<ts.Declaration, ComponentRecord>,
  tsApi: TsApi,
): ComponentRecord | undefined {
  if (!symbol) return undefined;
  let s = symbol;
  if (s.flags & tsApi.SymbolFlags.Alias) {
    try {
      s = checker.getAliasedSymbol(s);
    } catch {
      return undefined;
    }
  }
  for (const decl of s.declarations ?? []) {
    const component = componentsByDecl.get(decl);
    if (component) return component;
  }
  return undefined;
}

function isOpaqueType(type: ts.Type, checker: ts.TypeChecker, tsApi: TsApi): boolean {
  if (type.flags & (tsApi.TypeFlags.Any | tsApi.TypeFlags.Unknown)) return true;
  return checker.getIndexInfosOfType(type).length > 0;
}

function getOrCreatePassStats(component: ComponentRecord, propName: string): PassStats {
  const existing = component.passed.get(propName);
  if (existing) return existing;
  const created: PassStats = {
    files: new Set(),
    nonTestSites: new Set(),
    trueCount: 0,
    falseCount: 0,
    literalValues: new Set(),
    unknownValueInNonTest: false,
    possiblyUndefinedInNonTest: false,
  };
  component.passed.set(propName, created);
  return created;
}

function recordPassed(
  component: ComponentRecord,
  propName: string,
  fileName: string,
  options: RecordPassedOptions,
): void {
  const stats = getOrCreatePassStats(component, propName);
  stats.files.add(fileName);

  if (options.isTestFile) return;

  stats.nonTestSites.add(options.siteId);
  if (options.fromSpread) {
    // A spread's optional member may be absent at runtime entirely.
    stats.unknownValueInNonTest = true;
    stats.possiblyUndefinedInNonTest = true;
    return;
  }

  if (options.literal === undefined) {
    stats.unknownValueInNonTest = true;
    if (options.possiblyUndefined !== false) stats.possiblyUndefinedInNonTest = true;
    return;
  }

  if (options.literal === true) stats.trueCount += 1;
  if (options.literal === false) stats.falseCount += 1;
  stats.literalValues.add(String(options.literal));
}

export function collectUsages({
  program,
  checker,
  componentsByDecl,
  componentNames,
  isProjectFile,
  ts: tsApi,
}: CollectUsagesArgs): void {
  function recordRenderSite(
    tagName: ts.JsxTagNameExpression,
    attributes: ts.JsxAttributes,
    childrenPassed: boolean,
    sf: ts.SourceFile,
    siteId: string,
  ): void {
    const component = resolveToComponent(
      checker.getSymbolAtLocation(tagName),
      checker,
      componentsByDecl,
      tsApi,
    );
    if (!component) return;

    component.renderSites += 1;
    const isTestFile = TEST_FILE_RE.test(sf.fileName);
    if (!isTestFile) component.renderSitesNonTest += 1;

    for (const attr of attributes.properties) {
      if (tsApi.isJsxAttribute(attr)) {
        const literal = literalFromAttribute(attr, tsApi);
        let possiblyUndefined: boolean | undefined;
        if (
          literal === undefined &&
          attr.initializer &&
          tsApi.isJsxExpression(attr.initializer) &&
          attr.initializer.expression
        ) {
          possiblyUndefined = typeAdmitsUndefined(
            checker.getTypeAtLocation(attr.initializer.expression),
            tsApi,
          );
        }
        recordPassed(component, attr.name.getText(sf), sf.fileName, {
          isTestFile,
          siteId,
          literal,
          possiblyUndefined,
        });
      } else if (tsApi.isJsxSpreadAttribute(attr)) {
        const spreadType = checker.getTypeAtLocation(attr.expression);
        const members = spreadType.isUnion() ? spreadType.types : [spreadType];
        for (const member of members) {
          if (isOpaqueType(member, checker, tsApi)) {
            component.opaqueSpreadFiles.add(sf.fileName);
          } else {
            for (const prop of member.getProperties()) {
              recordPassed(component, prop.name, sf.fileName, {
                isTestFile,
                siteId,
                fromSpread: true,
              });
            }
          }
        }
      }
    }

    if (childrenPassed) {
      recordPassed(component, 'children', sf.fileName, {
        isTestFile,
        siteId,
        possiblyUndefined: false,
      });
    }
  }

  for (const sf of program.getSourceFiles()) {
    if (!isProjectFile(sf)) continue;

    let siteCounter = 0;
    const visit = (node: ts.Node): void => {
      if (tsApi.isJsxSelfClosingElement(node)) {
        siteCounter += 1;
        recordRenderSite(node.tagName, node.attributes, false, sf, `${sf.fileName}:${siteCounter}`);
      } else if (tsApi.isJsxElement(node)) {
        siteCounter += 1;
        recordRenderSite(
          node.openingElement.tagName,
          node.openingElement.attributes,
          hasMeaningfulChildren(node, tsApi),
          sf,
          `${sf.fileName}:${siteCounter}`,
        );
      } else if (
        tsApi.isIdentifier(node) &&
        componentNames.has(node.text) &&
        !isJsxTagContext(node, tsApi) &&
        !isDeclarationContext(node, tsApi)
      ) {
        const component = resolveToComponent(
          checker.getSymbolAtLocation(node),
          checker,
          componentsByDecl,
          tsApi,
        );
        if (component) component.indirectRefFiles.add(sf.fileName);
      }
      tsApi.forEachChild(node, visit);
    };
    visit(sf);
  }
}
