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

## Next (High ROI)

Prioritize these for strongest practical value:

- Prop always passed as the same literal value (required, or optional when present).
- Default/fallback branch never exercised by production callsites.
- Callback prop passed by parents but never invoked by the component.
- Prop accepted by component but never consumed and never forwarded.

## Later (Advanced Relational Checks)

- Cross-prop implication rules (A implies B, or A forces B to one value).
- Mutually exclusive props that always co-occur in practice.
- API collapse suggestions when multiple props encode one mode.

## Product-Level Improvements

- Rule-level flags to enable/disable checks independently.
- Severity tiers per rule family (definite vs advisory).
- Stable JSON schema versioning for CI/tool integrations.
- Per-finding fix suggestions in CLI output.
