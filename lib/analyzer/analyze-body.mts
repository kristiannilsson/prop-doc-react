import type ts from 'typescript';
import type { BodyUsage, ComponentRecord, TsApi } from './types.mjs';

const OPAQUE: BodyUsage = {
  opaque: true,
  consumed: new Set(),
  defaulted: new Set(),
  restRemainders: [],
};

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
  if (!param || !fnNode.body) return OPAQUE;

  const usage: BodyUsage = { opaque: false, consumed: new Set(), defaulted: new Set(), restRemainders: [] };
  const identifiers = collectValueIdentifiers(fnNode, tsApi);

  function processPattern(pattern: ts.ObjectBindingPattern): void {
    const named = new Set<string>();
    let rest: ts.Identifier | undefined;
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) {
        if (tsApi.isIdentifier(element.name)) rest = element.name;
        else usage.opaque = true;
        continue;
      }
      const nameSource = element.propertyName ?? element.name;
      let propName: string;
      if (tsApi.isIdentifier(nameSource)) propName = nameSource.text;
      else if (tsApi.isStringLiteral(nameSource)) propName = nameSource.text;
      else {
        // Computed or otherwise dynamic property name: can't tell which prop.
        usage.opaque = true;
        continue;
      }
      named.add(propName);
      if (element.initializer) usage.defaulted.add(propName);
      if (tsApi.isIdentifier(element.name)) {
        if (isBindingReferenced(element.name, identifiers, checker, tsApi)) usage.consumed.add(propName);
      } else {
        // Nested destructuring reads into the prop; count it as consumed.
        usage.consumed.add(propName);
      }
    }
    if (rest && isBindingReferenced(rest, identifiers, checker, tsApi)) {
      usage.restRemainders.push(named);
    }
  }

  if (tsApi.isObjectBindingPattern(param.name)) {
    processPattern(param.name);
    return usage.opaque ? OPAQUE : usage;
  }
  if (!tsApi.isIdentifier(param.name)) return OPAQUE;

  const paramSymbol = checker.getSymbolAtLocation(param.name);
  if (!paramSymbol) return OPAQUE;

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
      processPattern(parent.name);
    } else {
      // The props object escapes (aliased, spread, passed to a call, ...).
      return OPAQUE;
    }
  }

  return usage.opaque ? OPAQUE : usage;
}
