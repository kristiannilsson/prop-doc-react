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
- Prop always passed the same literal value when provided (`same-literal`).

## Next: See the whole program

- Follow TypeScript project references (or accept multiple tsconfig paths) so monorepo cross-package render sites are visible. Without this, the tool over-reports on exactly the codebases big enough to have prop drift.
- Public-API awareness: components exported from the package entry point may have consumers outside the program. Demote their findings to low confidence automatically, or gate on an `--internal-only` style flag, so design-system packages aren't all false positives.

## Later (Advanced Relational Checks)

- Cross-prop implication rules (A implies B, or A forces B to one value).
- Mutually exclusive props that always co-occur in practice.
- API collapse suggestions when multiple props encode one mode.

## Product-Level Improvements

- Stable JSON schema versioning for CI/tool integrations.
- Per-finding fix suggestions in CLI output.

## Non-goals

- ESLint plugin packaging: the analysis is inherently whole-program and fights ESLint's per-file model. The standalone CLI with stable JSON output is the integration surface.
