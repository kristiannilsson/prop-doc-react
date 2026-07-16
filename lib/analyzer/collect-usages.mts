import ts from 'typescript';
import type { ComponentRecord, LiteralValue, PassStats, TextSpan } from './types.mjs';
import { literalKey } from './constants.mjs';

interface CollectUsagesArgs {
  program: ts.Program;
  checker: ts.TypeChecker;
  componentsByDecl: Map<ts.Declaration, ComponentRecord>;
  componentNames: Set<string>;
  isProjectFile: (sf: ts.SourceFile) => boolean;
  isTestFile: (fileName: string) => boolean;
}

interface RecordPassedOptions {
  isTestFile: boolean;
  siteId: string;
  fromSpread?: boolean;
  literal?: LiteralValue;
  /** For non-literal values: whether the expression's type admits undefined. Defaults to true (conservative). */
  possiblyUndefined?: boolean;
  /** For attribute passes: the span deleting the source attribute (fix target). */
  attrSpan?: TextSpan;
  /** For attribute passes: the initializer is side-effect-free, so whole-prop removal may delete the attribute. */
  attrDeletable?: boolean;
}

function isJsxTagContext(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (
    ts.isJsxOpeningElement(parent) ||
    ts.isJsxSelfClosingElement(parent) ||
    ts.isJsxClosingElement(parent)
  ) {
    return true;
  }
  if (ts.isPropertyAccessExpression(parent)) {
    const grand = parent.parent;
    return (
      ts.isJsxOpeningElement(grand) ||
      ts.isJsxSelfClosingElement(grand) ||
      ts.isJsxClosingElement(grand)
    );
  }
  return false;
}

function isDeclarationContext(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (
    ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)) &&
      parent.name === identifier) ||
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportAssignment(parent)
  );
}

function hasMeaningfulChildren(jsxElement: ts.JsxElement): boolean {
  return jsxElement.children.some(
    (child) => !ts.isJsxText(child) || child.text.trim().length > 0,
  );
}

function literalFromAttribute(attr: ts.JsxAttribute): LiteralValue | undefined {
  if (!attr.initializer) return true;
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
  if (!ts.isJsxExpression(attr.initializer)) return undefined;
  const expr = attr.initializer.expression;
  if (!expr) return undefined;
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (
    ts.isPrefixUnaryExpression(expr) &&
    (expr.operator === ts.SyntaxKind.MinusToken || expr.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(expr.operand)
  ) {
    const n = Number(expr.operand.text);
    return expr.operator === ts.SyntaxKind.MinusToken ? -n : n;
  }
  return undefined;
}

// The span covers the attribute plus the whitespace separating it from the
// previous token, so deleting it never leaves double spaces or blank lines.
function attributeDeletionSpan(attr: ts.JsxAttribute, sf: ts.SourceFile): TextSpan {
  let start = attr.getStart(sf);
  while (start > 0 && /\s/.test(sf.text[start - 1])) start -= 1;
  return { file: sf.fileName, start, end: attr.getEnd() };
}

// Whether deleting the attribute cannot change behavior: evaluating its
// initializer has no side effects. Literals are handled by the caller.
function isSideEffectFreeInitializer(attr: ts.JsxAttribute): boolean {
  if (!attr.initializer) return true; // bare attribute
  if (ts.isStringLiteral(attr.initializer)) return true;
  if (!ts.isJsxExpression(attr.initializer) || !attr.initializer.expression) return false;
  const expr = attr.initializer.expression;
  return ts.isArrowFunction(expr) || ts.isFunctionExpression(expr) || ts.isIdentifier(expr);
}

function typeAdmitsUndefined(type: ts.Type): boolean {
  const loose =
    ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown;
  if (type.flags & loose) return true;
  return type.isUnion() && type.types.some((t) => (t.flags & loose) !== 0);
}

function resolveToComponent(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  componentsByDecl: Map<ts.Declaration, ComponentRecord>,): ComponentRecord | undefined {
  if (!symbol) return undefined;
  let s = symbol;
  if (s.flags & ts.SymbolFlags.Alias) {
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

function isOpaqueType(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  return checker.getIndexInfosOfType(type).length > 0;
}

function getOrCreatePassStats(component: ComponentRecord, propName: string): PassStats {
  const existing = component.passed.get(propName);
  if (existing) return existing;
  const created: PassStats = {
    files: new Set(),
    nonTestSites: new Set(),
    literalValues: new Set(),
    unknownValueInNonTest: false,
    possiblyUndefinedInNonTest: false,
    unknownValueInTest: false,
    literalAttrSpans: new Map(),
    passedAttrCount: 0,
    deletableAttrSpans: [],
    passedViaNonAttribute: false,
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

  if (options.attrSpan === undefined) {
    stats.passedViaNonAttribute = true;
  } else {
    stats.passedAttrCount += 1;
    if (options.attrDeletable) stats.deletableAttrSpans.push(options.attrSpan);
    if (options.literal !== undefined) {
      const key = literalKey(options.literal);
      const spans = stats.literalAttrSpans.get(key);
      if (spans) spans.push(options.attrSpan);
      else stats.literalAttrSpans.set(key, [options.attrSpan]);
    }
  }

  if (options.isTestFile) {
    if (options.fromSpread || options.literal === undefined) stats.unknownValueInTest = true;
    return;
  }

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

  stats.literalValues.add(literalKey(options.literal));
}

export function collectUsages({
  program,
  checker,
  componentsByDecl,
  componentNames,
  isProjectFile,
  isTestFile,
}: CollectUsagesArgs): void {
  function recordAttribute(
    component: ComponentRecord,
    attr: ts.JsxAttribute,
    sf: ts.SourceFile,
    inTestFile: boolean,
    siteId: string,
  ): void {
    const literal = literalFromAttribute(attr);
    let possiblyUndefined: boolean | undefined;
    if (
      literal === undefined &&
      attr.initializer &&
      ts.isJsxExpression(attr.initializer) &&
      attr.initializer.expression
    ) {
      possiblyUndefined = typeAdmitsUndefined(checker.getTypeAtLocation(attr.initializer.expression));
    }
    recordPassed(component, attr.name.getText(sf), sf.fileName, {
      isTestFile: inTestFile,
      siteId,
      literal,
      possiblyUndefined,
      attrSpan: attributeDeletionSpan(attr, sf),
      attrDeletable: literal !== undefined || isSideEffectFreeInitializer(attr),
    });
  }

  function recordSpreadAttribute(
    component: ComponentRecord,
    attr: ts.JsxSpreadAttribute,
    sf: ts.SourceFile,
    inTestFile: boolean,
    siteId: string,
  ): void {
    const spreadType = checker.getTypeAtLocation(attr.expression);
    const members = spreadType.isUnion() ? spreadType.types : [spreadType];
    for (const member of members) {
      if (isOpaqueType(member, checker)) {
        component.opaqueSpreadFiles.add(sf.fileName);
      } else {
        for (const prop of member.getProperties()) {
          recordPassed(component, prop.name, sf.fileName, {
            isTestFile: inTestFile,
            siteId,
            fromSpread: true,
          });
        }
      }
    }
  }

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
    );
    if (!component) return;

    component.renderSites += 1;
    const inTestFile = isTestFile(sf.fileName);
    if (!inTestFile) component.renderSitesNonTest += 1;

    for (const attr of attributes.properties) {
      if (ts.isJsxAttribute(attr)) recordAttribute(component, attr, sf, inTestFile, siteId);
      else if (ts.isJsxSpreadAttribute(attr)) recordSpreadAttribute(component, attr, sf, inTestFile, siteId);
    }

    if (childrenPassed) {
      recordPassed(component, 'children', sf.fileName, {
        isTestFile: inTestFile,
        siteId,
        possiblyUndefined: false,
      });
    }
  }

  for (const sf of program.getSourceFiles()) {
    if (!isProjectFile(sf)) continue;

    let siteCounter = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node)) {
        siteCounter += 1;
        recordRenderSite(node.tagName, node.attributes, false, sf, `${sf.fileName}:${siteCounter}`);
      } else if (ts.isJsxElement(node)) {
        siteCounter += 1;
        recordRenderSite(
          node.openingElement.tagName,
          node.openingElement.attributes,
          hasMeaningfulChildren(node),
          sf,
          `${sf.fileName}:${siteCounter}`,
        );
      } else if (
        ts.isIdentifier(node) &&
        componentNames.has(node.text) &&
        !isJsxTagContext(node) &&
        !isDeclarationContext(node)
      ) {
        const component = resolveToComponent(
          checker.getSymbolAtLocation(node),
          checker,
          componentsByDecl,
        );
        if (component) component.indirectRefFiles.add(sf.fileName);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}
