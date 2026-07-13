import type ts from 'typescript';
import type { ComponentRecord, TsApi } from './types.mjs';
import { WRAPPER_NAMES } from './constants.mjs';

interface CollectComponentsArgs {
  program: ts.Program;
  isProjectFile: (sf: ts.SourceFile) => boolean;
  ts: TsApi;
}

interface CollectComponentsResult {
  components: ComponentRecord[];
  componentsByDecl: Map<ts.Declaration, ComponentRecord>;
  componentNames: Set<string>;
}

function unwrapWrapperCall(expr: ts.Expression, tsApi: TsApi): ts.ArrowFunction | ts.FunctionExpression | undefined {
  let node: ts.Expression = expr;
  for (let depth = 0; depth < 4 && tsApi.isCallExpression(node); depth++) {
    const callee = node.expression;
    const calleeName = tsApi.isIdentifier(callee)
      ? callee.text
      : tsApi.isPropertyAccessExpression(callee) && tsApi.isIdentifier(callee.name)
        ? callee.name.text
        : undefined;
    if (!calleeName || !WRAPPER_NAMES.has(calleeName) || node.arguments.length === 0) {
      return undefined;
    }
    node = node.arguments[0];
  }
  return tsApi.isArrowFunction(node) || tsApi.isFunctionExpression(node) ? node : undefined;
}

function createComponentRecord(
  name: string,
  fnNode: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
): ComponentRecord {
  return {
    name,
    fnNode,
    sourceFile,
    renderSites: 0,
    renderSitesNonTest: 0,
    passed: new Map(),
    opaqueSpreadFiles: new Set(),
    indirectRefFiles: new Set(),
    publicApi: false,
  };
}

export function collectComponents({ program, isProjectFile, ts: tsApi }: CollectComponentsArgs): CollectComponentsResult {
  const componentsByDecl = new Map<ts.Declaration, ComponentRecord>();
  const components: ComponentRecord[] = [];
  const componentNames = new Set<string>();

  function registerComponent(
    name: string,
    fnNode: ts.FunctionLikeDeclaration,
    declNodes: ts.Declaration[],
    sourceFile: ts.SourceFile,
  ): void {
    if (fnNode.parameters.length === 0) return;
    const component = createComponentRecord(name, fnNode, sourceFile);
    components.push(component);
    componentNames.add(name);
    for (const decl of declNodes) componentsByDecl.set(decl, component);
  }

  for (const sf of program.getSourceFiles()) {
    if (!isProjectFile(sf)) continue;
    const visit = (node: ts.Node): void => {
      if (tsApi.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text)) {
        registerComponent(node.name.text, node, [node], sf);
      } else if (
        tsApi.isVariableDeclaration(node) &&
        tsApi.isIdentifier(node.name) &&
        /^[A-Z]/.test(node.name.text) &&
        node.initializer
      ) {
        const fn =
          tsApi.isArrowFunction(node.initializer) || tsApi.isFunctionExpression(node.initializer)
            ? node.initializer
            : unwrapWrapperCall(node.initializer, tsApi);
        if (fn) registerComponent(node.name.text, fn, [node], sf);
      }
      tsApi.forEachChild(node, visit);
    };
    visit(sf);
  }

  return { components, componentsByDecl, componentNames };
}
