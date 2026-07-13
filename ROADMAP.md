# Roadmap

This roadmap focuses on checks that are generally *not* covered by standard TypeScript checks or common lint rules.

## Current

Implemented and shipping:

- Optional prop never passed by any parent.
- Optional prop passed only from test/story files.
- Optional prop always passed by non-test parents.
- Optional boolean one-sided usage (true-only or false-only when provided).
- Optional union literal variants never used.
- Confidence modeling for opaque spreads and indirect component references.
- Severity tiers per rule family (definite vs advisory), reflected in the exit code: only high-confidence definite findings fail the gate.
- Rule-level enable/disable via `--rules`.
- Minimum render-site threshold for statistical rules (`always`, boolean one-sided, union variants) via `--min-sites` (default 3), so "always passed" can't mean "passed once".
- Baseline file (`--write-baseline` / `--baseline`): record current findings, fail only on *new* ones — makes the CI gate adoptable on existing codebases without a full cleanup first.
- Inline suppression comments on the prop declaration (`// prop-doc-ignore` or `// prop-doc-ignore <rule, ...>`).

## Next: Consumption analysis (the marquee rules)

Both require the same new capability — analyzing how the component *body* uses its props (destructuring, `props.x` access, rest-spread forwarding), conservatively:

- Prop accepted by component but never consumed and never forwarded.
- Callback prop passed by parents but never invoked by the component.
- Default/fallback value never exercised (destructuring default + every production callsite passes the prop).

## Next: See the whole program

- Follow TypeScript project references (or accept multiple tsconfig paths) so monorepo cross-package render sites are visible. Without this, the tool over-reports on exactly the codebases big enough to have prop drift.
- Public-API awareness: components exported from the package entry point may have consumers outside the program. Demote their findings to low confidence automatically, or gate on an `--internal-only` style flag, so design-system packages aren't all false positives.

## Quick wins

- Prop always passed as the same literal value (nearly free: literal values are already collected).

## Later (Advanced Relational Checks)

- Cross-prop implication rules (A implies B, or A forces B to one value).
- Mutually exclusive props that always co-occur in practice.
- API collapse suggestions when multiple props encode one mode.

## Product-Level Improvements

- Stable JSON schema versioning for CI/tool integrations.
- Per-finding fix suggestions in CLI output.

## Non-goals

- ESLint plugin packaging: the analysis is inherently whole-program and fights ESLint's per-file model. The standalone CLI with stable JSON output is the integration surface.

## Known fixes (not roadmap items, just tracked)

- Test-file classification should test paths *relative to the tsconfig directory*, so a repo living under a `/test/` or `/fixtures/` path segment isn't misclassified wholesale.
- Literal-value tracking should key by type so boolean `true` and string `"true"` union variants don't collide.
