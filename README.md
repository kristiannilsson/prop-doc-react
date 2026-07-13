# @kristiannilsson/prop-doc-react

Find React component prop-API drift that accumulates silently across a codebase:

- optional props that no parent ever passes,
- optional props always passed by production parents (candidate required props),
- optional boolean props that are only ever passed one side,
- optional union variants that are never used.

The component handles the prop correctly, the types check, the branch is tested by nothing and reachable by nothing. Greps can't find these because the evidence is an *absence* spread across every other file. This tool runs a whole-program analysis with the TypeScript type checker and reports them.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned rules and priorities.

## Usage

```sh
npx @kristiannilsson/prop-doc-react [path/to/tsconfig.json]
```

Defaults to `./tsconfig.json`.

```
src/components/common/LoadingDialog.tsx
  <LoadingDialog> — 3 render site(s)
    message                      never passed by any parent

src/components/booking-form/FormSection.tsx
  <FormSection> — 10 render site(s)
    icon                         never passed by any parent
    py                           never passed by any parent

33 finding(s) across 25 component(s) (33 definite). 205 components analyzed, 0 skipped.
```

### Options

| Flag                          | Effect                                                                 |
| ----------------------------- | ---------------------------------------------------------------------- |
| `--json`                    | Machine-readable output                                                |
| `--verbose`                 | Also list components skipped due to untyped spreads                    |
| `--include-test-components` | Analyze components defined in test/story files too                     |
| `--rules <list>`            | Comma-separated rules to run (default: all)                            |
| `--min-sites <n>`           | Non-test sites required before statistical rules fire (default: 3)     |
| `--baseline <path>`         | Ignore findings recorded in the baseline; only new findings gate CI    |
| `--write-baseline`          | Record the current findings to the baseline file and exit 0            |

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
3. Reports optional props — declared in *your* code, not inherited from library types — that are never passed, only passed from tests, always passed by non-test parents, one-sided booleans, or dead union variants.

## Avoiding false positives

- A spread typed `any` / `unknown` or with an index signature could pass anything, so the component is **skipped** rather than guessed at (listed under `--verbose`).
- A component that also escapes as a plain value (`component={Foo}`, HOCs, `createElement`) may receive props through paths the analysis can't see; its findings are marked **low confidence** and don't affect the exit code.
- Props passed *only* from test/story files are reported as a separate `tests-only` category, and components *defined* in test files are excluded by default.

## Known blind spots

- `React.createElement` calls and class components aren't analyzed.
- Render sites are matched per JSX tag; a prop threaded through render-prop plumbing to a low-confidence component may still be a false positive — hence the marker.
- A repo living under a path containing a `/test/` or `/fixtures/` segment will have its files misclassified as test files.

## License

MIT
