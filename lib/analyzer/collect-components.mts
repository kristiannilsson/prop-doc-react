import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { ComponentRecord } from './types.mjs';

const WRAPPER_NAMES = new Set(['memo', 'forwardRef', 'observer']);

interface CollectComponentsArgs {
  program: ts.Program;
  isProjectFile: (sf: ts.SourceFile) => boolean;
}

interface CollectComponentsResult {
  components: ComponentRecord[];
  componentsByDecl: Map<ts.Declaration, ComponentRecord>;
  componentNames: Set<string>;
}

function calleeName(callee: ts.Expression): string | undefined {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    return callee.name.text;
  }
  return undefined;
}

function unwrapWrapperCall(
  expr: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  let node: ts.Expression = expr;
  for (let depth = 0; depth < 4 && ts.isCallExpression(node); depth++) {
    const name = calleeName(node.expression);
    if (!name || !WRAPPER_NAMES.has(name) || node.arguments.length === 0) return undefined;
    node = node.arguments[0];
  }
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) ? node : undefined;
}

export function collectComponents({
  program,
  isProjectFile,
}: CollectComponentsArgs): CollectComponentsResult {
  const componentsByDecl = new Map<ts.Declaration, ComponentRecord>();
  const components: ComponentRecord[] = [];
  const componentNames = new Set<string>();

  function registerComponent(
    name: string,
    fnNode: ts.FunctionLikeDeclaration,
    decl: ts.Declaration,
    sourceFile: ts.SourceFile,
  ): void {
    if (fnNode.parameters.length === 0) return;
    const component: ComponentRecord = {
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
    components.push(component);
    componentNames.add(name);
    componentsByDecl.set(decl, component);
  }

  for (const sf of program.getSourceFiles()) {
    if (!isProjectFile(sf)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text)) {
        registerComponent(node.name.text, node, node, sf);
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        /^[A-Z]/.test(node.name.text) &&
        node.initializer
      ) {
        const fn =
          ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)
            ? node.initializer
            : unwrapWrapperCall(node.initializer);
        if (fn) registerComponent(node.name.text, fn, node, sf);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return { components, componentsByDecl, componentNames };
}

interface MarkPublicComponentsArgs {
  configDirs: string[];
  program: ts.Program;
  checker: ts.TypeChecker;
  componentsByDecl: Map<ts.Declaration, ComponentRecord>;
}

function harvestStrings(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') into.add(value);
  else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) harvestStrings(v, into);
  }
}

function findSourceFile(program: ts.Program, resolvedPath: string): ts.SourceFile | undefined {
  const wanted = resolvedPath.replaceAll('\\', '/').toLowerCase();
  return program.getSourceFiles().find((sf) => sf.fileName.toLowerCase() === wanted);
}

/**
 * Mark components reachable from a non-private package's entry points
 * (`exports`/`main`/`module`/`types` plus conventional index barrels): they
 * may have consumers outside this program, so their findings must not gate CI.
 */
export function markPublicComponents({
  configDirs,
  program,
  checker,
  componentsByDecl,
}: MarkPublicComponentsArgs): void {
  for (const dir of configDirs) {
    let pkg: { private?: boolean; [k: string]: unknown };
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as typeof pkg;
    } catch {
      continue;
    }
    if (pkg.private === true) continue;

    const candidates = new Set<string>();
    harvestStrings(pkg.exports, candidates);
    for (const field of ['main', 'module', 'browser', 'types']) {
      const value = pkg[field];
      if (typeof value === 'string') candidates.add(value);
    }
    for (const barrel of [
      'index.ts',
      'index.tsx',
      'index.mts',
      'src/index.ts',
      'src/index.tsx',
      'src/index.mts',
    ]) {
      candidates.add(barrel);
    }

    for (const candidate of candidates) {
      const sf = findSourceFile(program, path.resolve(dir, candidate));
      if (!sf || sf.isDeclarationFile) continue;
      const moduleSymbol = checker.getSymbolAtLocation(sf);
      if (!moduleSymbol) continue;
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        let symbol = exported;
        if (symbol.flags & ts.SymbolFlags.Alias) {
          try {
            symbol = checker.getAliasedSymbol(symbol);
          } catch {
            continue;
          }
        }
        for (const decl of symbol.declarations ?? []) {
          const component = componentsByDecl.get(decl);
          if (component) component.publicApi = true;
        }
      }
    }
  }
}
