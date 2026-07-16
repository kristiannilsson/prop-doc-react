import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { ComponentRecord } from './types.mjs';

interface MarkPublicComponentsArgs {
  configDirs: string[];
  program: ts.Program;
  checker: ts.TypeChecker;
  componentsByDecl: Map<ts.Declaration, ComponentRecord>;
}

/** Collect every string leaf of a package.json `exports` value. */
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
 * Mark components reachable from a package's public entry point: they may
 * have consumers outside this program, so their findings must not gate CI.
 *
 * A package is considered publishable when a `package.json` sits next to its
 * tsconfig and is not `"private": true`. Entry candidates come from that
 * file's `exports`/`main`/`module`/`types` fields plus the conventional
 * `index.ts(x)` / `src/index.ts(x)` barrels; candidates that resolve to a
 * source file in the program have their exports (including re-exports)
 * resolved back to component declarations.
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
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      continue; // no package.json next to this tsconfig -> internal code
    }
    if (pkg.private === true) continue; // apps can't have external consumers

    const candidates = new Set<string>();
    harvestStrings(pkg.exports, candidates);
    for (const field of ['main', 'module', 'browser', 'types']) {
      if (typeof pkg[field] === 'string') candidates.add(pkg[field] as string);
    }
    for (const barrel of ['index.ts', 'index.tsx', 'index.mts', 'src/index.ts', 'src/index.tsx', 'src/index.mts']) {
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
