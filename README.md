# @kristiannilsson/prop-doc-react

Find React component prop-API drift that accumulates silently across a codebase:

- optional props that no parent ever passes,
- optional props always passed by production parents (candidate required props),
- optional union variants that are never used,
- props (required ones too) the component body never reads or forwards,
- callback props parents pass that the component never references,
- props always passed the same literal value (fold it into a default),
- callsites that always pass exactly the destructuring default (delete the attribute),
- wide `string`/`number` props only ever passed a small literal set (narrow to a union type).

The component handles the prop correctly, the types check, the branch is tested by nothing and reachable by nothing. Greps can't find these because the evidence is an _absence_ spread across every other file. This tool runs a whole-program analysis with the TypeScript type checker and reports them.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned rules and priorities.

## Usage

```sh
npx @kristiannilsson/prop-doc-react [path/to/tsconfig.json ...]
```

Defaults to `./tsconfig.json`. Multiple tsconfig paths merge into one program so cross-package render sites in a monorepo are visible, and TypeScript project references are followed automatically. (Cross-package imports must resolve to sources — relative paths or `paths` aliases.)

```
Definite Findings (4)

src/components/common/LoadingDialog.tsx
  <LoadingDialog> — 3 render site(s)
    message                      [never] never passed by any parent

src/components/booking-form/FormSection.tsx
  <FormSection> — 10 render site(s)
    icon                         [never] never passed by any parent
    py                           [never] never passed by any parent

src/components/table/StatusIcon.tsx
  <StatusIcon> — 1 render site(s)
    onOpenDialog                 [callback-never-invoked] callback passed by parents but never referenced by the component

Advisory Findings (2)

src/components/booking-form/FormSection.tsx
  <FormSection> — 10 render site(s)
    compact                      [always] passed by every non-test parent (10 non-test render site(s))

src/containers/common/CustomerSelector.tsx
  <CustomerSelector> — 6 render site(s)
    width                        [same-literal] always passed the same value when provided: 450

6 finding(s) across 4 component(s) (4 definite). 205 components analyzed, 0 skipped.
```

### Options

| Flag                          | Effect                                                              |
| ----------------------------- | ------------------------------------------------------------------- |
| `--json`                    | Machine-readable output                                             |
| `--verbose`                 | Also list components skipped due to untyped spreads                 |
| `--include-test-components` | Analyze components defined in test/story files too                  |
| `--rules <list>`            | Comma-separated rules to run (default: all)                         |
| `--min-sites <n>`           | Non-test sites required before statistical rules fire (default: 3)  |
| `--baseline <path>`         | Ignore findings recorded in the baseline; only new findings gate CI |
| `--write-baseline`          | Record the current findings to the baseline file and exit 0         |
| `--assume-internal`         | Treat every component as internal (skip public-API demotion)        |
| `--fix`                     | Apply safe fixes, then re-analyze and report what remains           |
| `--dry-run`                 | With`--fix`: print the planned edits without changing any file    |

### Autofix

`--fix` applies edits that are mechanical and behavior-preserving. Fixable rules:

- `passed-equals-default` — deletes the redundant attribute at every callsite whose value was verified to be the literal default (a callsite passing the default through a variable is left alone).
- `same-literal` — folds the always-passed literal into the destructuring default (replacing a never-exercised default, or inserting one) and deletes the attribute everywhere; only when the prop is optional, destructured, and _every_ render site verifiably passes that literal.
- `type-wider-than-usage` — replaces a bare `string`/`number` annotation with the observed-literal union.
- `union-variant-never` — rewrites a direct union type keeping only variants some site passes.
- `never` / `unconsumed` / `callback-never-invoked` — removes the prop entirely: the declaration line, the (unreferenced) destructuring binding, and every callsite attribute. Only when the body verifiably ignores the prop and every callsite value is side-effect-free (literal, arrow/function expression, bare identifier); a spread, JSX nesting, or a call-expression value blocks the fix.

Low-confidence, public-API, and baselined findings are never fixed, and the type edits require literal values at every site (test files included) so narrowing can't break a caller. Runtime behavior is preserved; a pruned union variant can, by design, surface dead body branches (`mode === 'auto'`) as type errors — that's the dead code the finding was about. After writing, the analysis re-runs so the report reflects the post-fix state — including follow-up findings a fix exposes (a prop whose every callsite restated the default becomes a `never` prop once those attributes are gone).

### Adopting on an existing codebase

Record the findings you already have, then fail CI only on new ones:

```sh
npx @kristiannilsson/prop-doc-react --write-baseline   # commit .prop-doc-baseline.json
npx @kristiannilsson/prop-doc-react --baseline .prop-doc-baseline.json
```

Individual findings can be suppressed at the source with a comment on the prop declaration — bare to suppress every rule for that prop, or naming specific rules:

```ts
interface Props {
  // prop-doc-ignore
  legacyProp?: string;
  size?: 'sm' | 'md' | 'lg'; // prop-doc-ignore union-variant-never
}
```

### Exit codes

`1` when new definite findings exist (usable as a CI gate), `0` when clean or only advisory/low-confidence/baselined findings, `2` on usage/config errors.

### As a library

```js
import { analyzeProject } from '@kristiannilsson/prop-doc-react';

const { findings, skipped, componentsAnalyzed } = analyzeProject('tsconfig.json', {
  includeTestComponents: false,
});
```

## How it works

1. Collects component definitions: uppercase-named function declarations and variable declarations initialized with a function, unwrapping `memo` / `forwardRef` / `observer`.
2. Walks all JSX and resolves each tag back to its component symbol through imports and aliases, recording which attributes each render site passes. Spread attributes (`{...props}`) are expanded via their static type; JSX nesting counts as passing `children`.
3. Analyzes each component body's own prop usage — destructuring (including defaults and rest forwarding) and `props.x` access — bailing out conservatively when the props object escapes whole (aliased, spread, passed to a function).
4. Reports props — declared in _your_ code, not inherited from library types — that are never passed, only passed from tests, always passed by non-test parents, dead union variants, never consumed by the body, never-invoked callbacks, or redundantly restated at every callsite.

## Avoiding false positives

- A spread typed `any` / `unknown` or with an index signature could pass anything, so the component is **skipped** rather than guessed at (listed under `--verbose`).
- A component that also escapes as a plain value (`component={Foo}`, HOCs, `createElement`) may receive props through paths the analysis can't see; its findings are marked **low confidence** and don't affect the exit code.
- Props passed _only_ from test/story files are reported as a separate `tests-only` category, and components _defined_ in test files are excluded by default.
- Components exported from a non-`private` package's entry point may have consumers outside the program; their findings are marked **public API** and never gate the exit code (disable with `--assume-internal`).

## Known blind spots

- `React.createElement` calls and class components aren't analyzed.
- Render sites are matched per JSX tag; a prop threaded through render-prop plumbing to a low-confidence component may still be a false positive — hence the marker.

## License

MIT
