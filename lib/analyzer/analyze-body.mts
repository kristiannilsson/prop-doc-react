import type ts from 'typescript';
import type { BodyUsage, ComponentRecord, TextSpan, TsApi } from './types.mjs';
import { literalKey } from './constants.mjs';

function opaqueUsage(): BodyUsage {
  return {
    opaque: true,
    consumed: new Set(),
    defaulted: new Map(),
    restRemainders: [],
    defaultTargets: new Map(),
    bindingElementSpans: new Map(),
  };
}

// The span deletes the binding element together with one separating comma:
// up to the next element's start, or (for the last element) back through the
// previous element's end. A sole element keeps its exact span.
function bindingElementDeletionSpan(
  pattern: ts.ObjectBindingPattern,
  index: number,
  sf: ts.SourceFile,
): TextSpan {
  const elements = pattern.elements;
  const element = elements[index];
  if (index < elements.length - 1) {
    return { file: sf.fileName, start: element.getStart(sf), end: elements[index + 1].getStart(sf) };
  }
  if (index > 0) {
    return { file: sf.fileName, start: elements[index - 1].getEnd(), end: element.getEnd() };
  }
  return { file: sf.fileName, start: element.getStart(sf), end: element.getEnd() };
}

/** Type-tagged literal key of a default expression, or undefined when it isn't a literal. */
function literalKeyOfExpression(expr: ts.Expression, tsApi: TsApi): string | undefined {
  if (expr.kind === tsApi.SyntaxKind.TrueKeyword) return literalKey(true);
  if (expr.kind === tsApi.SyntaxKind.FalseKeyword) return literalKey(false);
  if (tsApi.isStringLiteral(expr) || tsApi.isNoSubstitutionTemplateLiteral(expr)) return literalKey(expr.text);
  if (tsApi.isNumericLiteral(expr)) return literalKey(Number(expr.text));
  if (
    tsApi.isPrefixUnaryExpression(expr) &&
    (expr.operator === tsApi.SyntaxKind.MinusToken || expr.operator === tsApi.SyntaxKind.PlusToken) &&
    tsApi.isNumericLiteral(expr.operand)
  ) {
    const n = Number(expr.operand.text);
    return literalKey(expr.operator === tsApi.SyntaxKind.MinusToken ? -n : n);
  }
  return undefined;
}

export function isConsumed(usage: BodyUsage, propName: string): boolean {
  if (usage.opaque || usage.consumed.has(propName)) return true;
  return usage.restRemainders.some((named) => !named.has(propName));
}

function inTypeContext(node: ts.Node, stopAt: ts.Node, tsApi: TsApi): boolean {
  for (let n = node.parent; n && n !== stopAt; n = n.parent) {
    if (tsApi.isTypeNode(n)) return true;
  }
  return false;
}

/** Identifier positions that are names/labels, not value references. */
function isNamePosition(id: ts.Identifier, tsApi: TsApi): boolean {
  const parent = id.parent;
  return (
    (tsApi.isPropertyAccessExpression(parent) && parent.name === id) ||
    (tsApi.isPropertyAssignment(parent) && parent.name === id) ||
    (tsApi.isBindingElement(parent) && parent.propertyName === id) ||
    (tsApi.isJsxAttribute(parent) && parent.name === id) ||
    tsApi.isQualifiedName(parent)
  );
}

function collectValueIdentifiers(
  fnNode: ts.FunctionLikeDeclaration,
  tsApi: TsApi,
): Map<string, ts.Identifier[]> {
  const byText = new Map<string, ts.Identifier[]>();
  const visit = (node: ts.Node): void => {
    if (tsApi.isIdentifier(node) && !isNamePosition(node, tsApi) && !inTypeContext(node, fnNode, tsApi)) {
      const list = byText.get(node.text);
      if (list) list.push(node);
      else byText.set(node.text, [node]);
    }
    tsApi.forEachChild(node, visit);
  };
  visit(fnNode);
  return byText;
}

function symbolAt(id: ts.Identifier, checker: ts.TypeChecker, tsApi: TsApi): ts.Symbol | undefined {
  // A shorthand property (`{ foo }` in an object literal) resolves to the
  // property symbol; the value side is what references the binding.
  if (tsApi.isShorthandPropertyAssignment(id.parent) && id.parent.name === id) {
    return checker.getShorthandAssignmentValueSymbol(id.parent);
  }
  return checker.getSymbolAtLocation(id);
}

function isBindingReferenced(
  nameNode: ts.Identifier,
  identifiers: Map<string, ts.Identifier[]>,
  checker: ts.TypeChecker,
  tsApi: TsApi,
): boolean {
  const symbol = checker.getSymbolAtLocation(nameNode);
  if (!symbol) return true; // unresolvable -> assume referenced rather than flag
  for (const id of identifiers.get(nameNode.text) ?? []) {
    if (id === nameNode) continue;
    if (symbolAt(id, checker, tsApi) === symbol) return true;
  }
  return false;
}

interface PatternContext {
  usage: BodyUsage;
  identifiers: Map<string, ts.Identifier[]>;
  checker: ts.TypeChecker;
  tsApi: TsApi;
}

function recordBindingElement(
  pattern: ts.ObjectBindingPattern,
  index: number,
  propName: string,
  { usage, identifiers, checker, tsApi }: PatternContext,
): void {
  const element = pattern.elements[index];
  const sf = element.getSourceFile();
  usage.bindingElementSpans.set(
    propName,
    usage.bindingElementSpans.has(propName)
      ? 'multiple'
      : bindingElementDeletionSpan(pattern, index, sf),
  );
  if (element.initializer) {
    usage.defaulted.set(propName, literalKeyOfExpression(element.initializer, tsApi));
    usage.defaultTargets.set(propName, {
      file: sf.fileName,
      start: element.initializer.getStart(sf),
      end: element.initializer.getEnd(),
    });
  } else if (tsApi.isIdentifier(element.name)) {
    // No default yet: a zero-length span marks where one can be inserted.
    usage.defaultTargets.set(propName, {
      file: sf.fileName,
      start: element.name.getEnd(),
      end: element.name.getEnd(),
    });
  }
  // Nested destructuring always reads into the prop; a plain binding only
  // counts as consumed when something references it.
  if (
    !tsApi.isIdentifier(element.name) ||
    isBindingReferenced(element.name, identifiers, checker, tsApi)
  ) {
    usage.consumed.add(propName);
  }
}

function processBindingPattern(pattern: ts.ObjectBindingPattern, ctx: PatternContext): void {
  const { usage, identifiers, checker, tsApi } = ctx;
  const named = new Set<string>();
  let rest: ts.Identifier | undefined;
  for (const [index, element] of pattern.elements.entries()) {
    if (element.dotDotDotToken) {
      if (tsApi.isIdentifier(element.name)) rest = element.name;
      else usage.opaque = true;
      continue;
    }
    const nameSource = element.propertyName ?? element.name;
    if (!tsApi.isIdentifier(nameSource) && !tsApi.isStringLiteral(nameSource)) {
      // Computed or otherwise dynamic property name: can't tell which prop.
      usage.opaque = true;
      continue;
    }
    named.add(nameSource.text);
    recordBindingElement(pattern, index, nameSource.text, ctx);
  }
  if (rest && isBindingReferenced(rest, identifiers, checker, tsApi)) {
    usage.restRemainders.push(named);
  }
}

/**
 * Analyze how a component body uses its props, conservatively: any use of the
 * props object that isn't a property access or a destructuring makes the
 * result opaque, so consumption rules stay silent instead of guessing.
 */
export function analyzeBodyUsage(
  component: ComponentRecord,
  checker: ts.TypeChecker,
  tsApi: TsApi,
): BodyUsage {
  const fnNode = component.fnNode;
  const param = fnNode.parameters[0];
  if (!param || !fnNode.body) return opaqueUsage();

  const usage: BodyUsage = {
    opaque: false,
    consumed: new Set(),
    defaulted: new Map(),
    restRemainders: [],
    defaultTargets: new Map(),
    bindingElementSpans: new Map(),
  };
  const identifiers = collectValueIdentifiers(fnNode, tsApi);
  const ctx: PatternContext = { usage, identifiers, checker, tsApi };

  if (tsApi.isObjectBindingPattern(param.name)) {
    processBindingPattern(param.name, ctx);
    return usage.opaque ? opaqueUsage() : usage;
  }
  if (!tsApi.isIdentifier(param.name)) return opaqueUsage();

  const paramSymbol = checker.getSymbolAtLocation(param.name);
  if (!paramSymbol) return opaqueUsage();

  for (const id of identifiers.get(param.name.text) ?? []) {
    if (id === param.name) continue;
    if (symbolAt(id, checker, tsApi) !== paramSymbol) continue;
    const parent = id.parent;
    if (tsApi.isPropertyAccessExpression(parent) && parent.expression === id) {
      usage.consumed.add(parent.name.text);
    } else if (
      tsApi.isElementAccessExpression(parent) &&
      parent.expression === id &&
      tsApi.isStringLiteral(parent.argumentExpression)
    ) {
      usage.consumed.add(parent.argumentExpression.text);
    } else if (
      tsApi.isVariableDeclaration(parent) &&
      parent.initializer === id &&
      tsApi.isObjectBindingPattern(parent.name)
    ) {
      processBindingPattern(parent.name, ctx);
    } else {
      // The props object escapes (aliased, spread, passed to a call, ...).
      return opaqueUsage();
    }
  }

  return usage.opaque ? opaqueUsage() : usage;
}
