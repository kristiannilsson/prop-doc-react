# Roadmap

This roadmap focuses on checks that are generally *not* covered by standard TypeScript checks or common lint rules.

## Current

Implemented and shipping:

- Optional prop never passed by any parent.
- Optional prop passed only from test/story files.
- Optional prop always passed by non-test parents (only counting values whose types exclude `undefined`).
- Optional boolean one-sided usage (true-only or false-only when provided).
- Optional union literal variants never used.
- Confidence modeling for opaque spreads and indirect component references.
- Severity tiers per rule family (definite vs advisory), reflected in the exit code: only high-confidence definite findings fail the gate.
- Rule-level enable/disable via `--rules`.
- Minimum render-site threshold for statistical rules (`always`, boolean one-sided, union variants) via `--min-sites` (default 3), so "always passed" can't mean "passed once".
- Baseline file (`--write-baseline` / `--baseline`): record current findings, fail only on *new* ones — makes the CI gate adoptable on existing codebases without a full cleanup first.
- Inline suppression comments on the prop declaration (`// prop-doc-ignore` or `// prop-doc-ignore <rule, ...>`).
- Consumption analysis of the component body (destructuring, `props.x` access, rest-spread forwarding; bails out when the props object escapes whole):
  - Prop accepted (required props included) but never read and never forwarded (`unconsumed`).
  - Callback prop passed by parents but never referenced by the component (`callback-never-invoked`).
  - Destructuring default never exercised — every non-test callsite passes a value whose type excludes `undefined` (`default-never-used`).
- Prop always passed the same literal value when provided (`same-literal`) — required props included.
- Union literal variants never used (`union-variant-never`) — required props included.
- Callsites that always pass exactly the destructuring default (`passed-equals-default`); wins over `default-never-used` / `same-literal` on the same evidence.
- Wide `string`/`number` props whose observed values are a small repeated literal set (`type-wider-than-usage`) — suggest a union type.
- Whole-program view: multiple tsconfig paths merge into one program, and TypeScript project references are followed automatically, so monorepo cross-package render sites are visible. (Note: cross-package imports must resolve to sources — relative paths or `paths` aliases; imports resolving to a package's built `.d.ts` are not connected back to the source component.)
- Public-API awareness: components exported from a non-`private` package's entry point (package.json `exports`/`main` or `index.ts` / `src/index.ts` barrels) are marked `publicApi` and never gate CI — external consumers are invisible to the program. `--assume-internal` disables the demotion.

## Next: See the whole program

- Resolve package-name imports (`@scope/ui`) that land on built `.d.ts` files back to the referenced project's sources, so monorepos that don't use source aliases also connect.

## Later: More consumption-based rules

- `forward-only`: prop consumed solely by forwarding it unchanged to a child JSX element, through 2+ layers — prop-drilling detection; the fix is context or composition.
- Value-identical prop pairs: two props every callsite passes the same value (`label` and `title`) — one is redundant. A gentler on-ramp to the relational machinery below.

## Later (Advanced Relational Checks)

These need a higher site-count bar than the default `--min-sites` to be trustworthy: "A and B always co-occur" has too many innocent explanations at 3–5 render sites.

- Cross-prop implication rules (A implies B, or A forces B to one value).
- Mutually exclusive props that always co-occur in practice.
- API collapse suggestions when multiple props encode one mode.

Note on ordering: rule trustworthiness is capped by program visibility. "See the whole program" comes before all new statistical rules — adding rules while cross-package callers are invisible multiplies the false-positive surface.

## Product-Level Improvements

- Stable JSON schema versioning for CI/tool integrations.
- Per-finding fix suggestions in CLI output.

## Non-goals

- ESLint plugin packaging: the analysis is inherently whole-program and fights ESLint's per-file model. The standalone CLI with stable JSON output is the integration surface.
