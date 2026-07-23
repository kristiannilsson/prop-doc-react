import { ts } from 'ts-morph';
import { literalKey, type BodyUsage, type ComponentRecord, type TextSpan } from './types.mjs';

function newUsage(opaque: boolean): BodyUsage {
  return {
    opaque,
    consumed: new Set(),
    defaulted: new Map(),
    restRemainders: [],
    defaultTargets: new Map(),
    bindingElementSpans: new Map(),
  };
}

const opaqueUsage = (): BodyUsage => newUsage(true);

// Deletes the binding element together with one separating comma: up to the
// next element's start, or (for the last element) back through the previous
// element's end.
function bindingElementDeletionSpan(
  pattern: ts.ObjectBindingPattern,
  index: number,
  sf: ts.SourceFile,
): TextSpan {
  const elements = pattern.elements;
  const element = elements[index];
  if (index < elements.length - 1) {
    return {
      file: sf.fileName,
      start: element.getStart(sf),
      end: elements[index + 1].getStart(sf),
    };
  }
  if (index > 0) {
    return { file: sf.fileName, start: elements[index - 1].getEnd(), end: element.getEnd() };
  }
  return { file: sf.fileName, start: element.getStart(sf), end: element.getEnd() };
}

function literalKeyOfExpression(expr: ts.Expression): string | undefined {
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return literalKey(true);
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return literalKey(false);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
    return literalKey(expr.text);
  if (ts.isNumericLiteral(expr)) return literalKey(Number(expr.text));
  if (
    ts.isPrefixUnaryExpression(expr) &&
    (expr.operator === ts.SyntaxKind.MinusToken || expr.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(expr.operand)
  ) {
    const n = Number(expr.operand.text);
    return literalKey(expr.operator === ts.SyntaxKind.MinusToken ? -n : n);
  }
  return undefined;
}

export function isConsumed(usage: BodyUsage, propName: string): boolean {
  if (usage.opaque || usage.consumed.has(propName)) return true;
  return usage.restRemainders.some((named) => !named.has(propName));
}

function inTypeContext(node: ts.Node, stopAt: ts.Node): boolean {
  for (let n = node.parent; n && n !== stopAt; n = n.parent) {
    if (ts.isTypeNode(n)) return true;
  }
  return false;
}

function isNamePosition(id: ts.Identifier): boolean {
  const parent = id.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === id) ||
    (ts.isPropertyAssignment(parent) && parent.name === id) ||
    (ts.isBindingElement(parent) && parent.propertyName === id) ||
    (ts.isJsxAttribute(parent) && parent.name === id) ||
    ts.isQualifiedName(parent)
  );
}

function collectValueIdentifiers(fnNode: ts.FunctionLikeDeclaration): Map<string, ts.Identifier[]> {
  const byText = new Map<string, ts.Identifier[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isNamePosition(node) && !inTypeContext(node, fnNode)) {
      const list = byText.get(node.text);
      if (list) list.push(node);
      else byText.set(node.text, [node]);
    }
    ts.forEachChild(node, visit);
  };
  visit(fnNode);
  return byText;
}

function symbolAt(id: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id) {
    return checker.getShorthandAssignmentValueSymbol(id.parent);
  }
  return checker.getSymbolAtLocation(id);
}

function isBindingReferenced(
  nameNode: ts.Identifier,
  identifiers: Map<string, ts.Identifier[]>,
  checker: ts.TypeChecker,
): boolean {
  const symbol = checker.getSymbolAtLocation(nameNode);
  if (!symbol) return true;
  for (const id of identifiers.get(nameNode.text) ?? []) {
    if (id === nameNode) continue;
    if (symbolAt(id, checker) === symbol) return true;
  }
  return false;
}

interface PatternContext {
  usage: BodyUsage;
  identifiers: Map<string, ts.Identifier[]>;
  checker: ts.TypeChecker;
}

function recordBindingElement(
  pattern: ts.ObjectBindingPattern,
  index: number,
  propName: string,
  { usage, identifiers, checker }: PatternContext,
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
    usage.defaulted.set(propName, literalKeyOfExpression(element.initializer));
    usage.defaultTargets.set(propName, {
      file: sf.fileName,
      start: element.initializer.getStart(sf),
      end: element.initializer.getEnd(),
    });
  } else if (ts.isIdentifier(element.name)) {
    usage.defaultTargets.set(propName, {
      file: sf.fileName,
      start: element.name.getEnd(),
      end: element.name.getEnd(),
    });
  }
  if (!ts.isIdentifier(element.name) || isBindingReferenced(element.name, identifiers, checker)) {
    usage.consumed.add(propName);
  }
}

function processBindingPattern(pattern: ts.ObjectBindingPattern, ctx: PatternContext): void {
  const { usage, identifiers, checker } = ctx;
  const named = new Set<string>();
  let rest: ts.Identifier | undefined;
  for (const [index, element] of pattern.elements.entries()) {
    if (element.dotDotDotToken) {
      if (ts.isIdentifier(element.name)) rest = element.name;
      else usage.opaque = true;
      continue;
    }
    const nameSource = element.propertyName ?? element.name;
    if (!ts.isIdentifier(nameSource) && !ts.isStringLiteral(nameSource)) {
      usage.opaque = true;
      continue;
    }
    named.add(nameSource.text);
    recordBindingElement(pattern, index, nameSource.text, ctx);
  }
  if (rest && isBindingReferenced(rest, identifiers, checker)) {
    usage.restRemainders.push(named);
  }
}

/**
 * Analyze how a component body uses its props, conservatively: any use of the
 * props object that isn't a property access or a destructuring makes the
 * result opaque, so consumption rules stay silent instead of guessing.
 */
export function analyzeBodyUsage(component: ComponentRecord, checker: ts.TypeChecker): BodyUsage {
  const fnNode = component.fnNode;
  const param = fnNode.parameters[0];
  if (!param || !fnNode.body) return opaqueUsage();

  const usage = newUsage(false);
  const identifiers = collectValueIdentifiers(fnNode);
  const ctx: PatternContext = { usage, identifiers, checker };

  if (ts.isObjectBindingPattern(param.name)) {
    processBindingPattern(param.name, ctx);
    return usage.opaque ? opaqueUsage() : usage;
  }
  if (!ts.isIdentifier(param.name)) return opaqueUsage();

  const paramSymbol = checker.getSymbolAtLocation(param.name);
  if (!paramSymbol) return opaqueUsage();

  for (const id of identifiers.get(param.name.text) ?? []) {
    if (id === param.name) continue;
    if (symbolAt(id, checker) !== paramSymbol) continue;
    const parent = id.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === id) {
      usage.consumed.add(parent.name.text);
    } else if (
      ts.isElementAccessExpression(parent) &&
      parent.expression === id &&
      ts.isStringLiteral(parent.argumentExpression)
    ) {
      usage.consumed.add(parent.argumentExpression.text);
    } else if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === id &&
      ts.isObjectBindingPattern(parent.name)
    ) {
      processBindingPattern(parent.name, ctx);
    } else {
      return opaqueUsage();
    }
  }

  return usage.opaque ? opaqueUsage() : usage;
}
