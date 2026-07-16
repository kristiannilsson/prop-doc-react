# Roadmap

This roadmap focuses on checks that are generally _not_ covered by standard TypeScript checks or common lint rules.

## Current

Implemented and shipping:

- Optional prop never passed by any parent.
- Optional prop passed only from test/story files.
- Optional prop always passed by non-test parents (only counting values whose types exclude `undefined`).
- Optional union literal variants never used.
- Confidence modeling for opaque spreads and indirect component references.
- Severity tiers per rule family (definite vs advisory), reflected in the exit code: only high-confidence definite findings fail the gate.
- Rule-level enable/disable via `--rules`.
- Minimum render-site threshold for statistical rules (`always`, union variants, `same-literal`) via `--min-sites` (default 3), so "always passed" can't mean "passed once".
- Baseline file (`--write-baseline` / `--baseline`): record current findings, fail only on _new_ ones — makes the CI gate adoptable on existing codebases without a full cleanup first.
- Inline suppression comments on the prop declaration (`// prop-doc-ignore` or `// prop-doc-ignore <rule, ...>`).
- Consumption analysis of the component body (destructuring, `props.x` access, rest-spread forwarding; bails out when the props object escapes whole):
  - Prop accepted (required props included) but never read and never forwarded (`unconsumed`).
  - Callback prop passed by parents but never referenced by the component (`callback-never-invoked`).
- Prop always passed the same literal value when provided (`same-literal`) — required props included.
- Union literal variants never used (`union-variant-never`) — required props included.
- Callsites that always pass exactly the destructuring default (`passed-equals-default`); wins over `same-literal` on the same evidence.
- Wide `string`/`number` props whose observed values are a small repeated literal set (`type-wider-than-usage`) — suggest a union type.
- Whole-program view: multiple tsconfig paths merge into one program, and TypeScript project references are followed automatically, so monorepo cross-package render sites are visible. (Note: cross-package imports must resolve to sources — relative paths or `paths` aliases; imports resolving to a package's built `.d.ts` are not connected back to the source component.)
- Public-API awareness: components exported from a non-`private` package's entry point (package.json `exports`/`main` or `index.ts` / `src/index.ts` barrels) are marked `publicApi` and never gate CI — external consumers are invisible to the program. `--assume-internal` disables the demotion.
  Removed (0.3): `default-never-used` duplicated `always` (an optional defaulted prop that every parent passes fired both on the same evidence), and the one-sided boolean rules (`boolean-never-true` / `boolean-never-false`) flagged the bare-attribute JSX idiom rather than drift.

- Autofix phases 1–3: `--fix` (with `--dry-run` preview) fixes `passed-equals-default` (delete the redundant attribute), `same-literal` (fold the literal into the destructuring default, delete the attributes), `type-wider-than-usage` (narrow to the observed union), `union-variant-never` (prune unseen variants), and `never`/`unconsumed`/`callback-never-invoked` (whole-prop removal: declaration, binding, callsite attributes), then re-runs the analysis; low-confidence, public-API, and baselined findings are never fixed, type edits require verified literals at every site (test files included), and removal requires the body to verifiably ignore the prop plus side-effect-free callsite values. Findings with a fixer carry their edits in the JSON output (`fix` spans).

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

## Later: Autofix

`--fix`: apply the change a finding implies, instead of just reporting it. Rolled out by fix shape, mechanical single-concern edits first:

1. ~~Callsite deletions — `passed-equals-default` (drop the attribute; it restates the default).~~ Shipped.
2. ~~Declaration-side edits — `type-wider-than-usage` (narrow to the observed union), `union-variant-never` (drop the dead variant), `same-literal` (fold the value into the destructuring default, then drop the attribute at every callsite).~~ Shipped.
3. ~~Whole-prop removal — `never`, `unconsumed`, `callback-never-invoked`: delete the prop from the type, the destructuring, and any callsites. Multi-file and entangled with body usage, so last.~~ Shipped — gated on the body verifiably ignoring the prop and every callsite value being side-effect-free.

Safety rules: fixability is a per-rule property (a fixer exists only where the edit is mechanical and behavior-preserving — the definite/advisory axis measures CI-gate worthiness, not fix safety); never fix low-confidence or `publicApi` findings; a diff/dry-run mode before writing; and the analysis re-runs after applying so a fix that changes the evidence for another finding is caught rather than compounded.

Implementation note: the analysis stays on the raw compiler API; the rewrite side is where ts-morph (or direct text edits from node spans) earns its place.

## Product-Level Improvements

- Stable JSON schema versioning for CI/tool integrations.
- Per-finding fix suggestions in CLI output (the reporting precursor to `--fix`).

## Non-goals

- ESLint plugin packaging: the analysis is inherently whole-program and fights ESLint's per-file model. The standalone CLI with stable JSON output is the integration surface.
