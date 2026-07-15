import fs from 'node:fs';
import type { Finding, FindingKind, FixEdit } from './analyzer/types.mjs';

/**
 * Rules whose `fix` edits are mechanical and behavior-preserving. Fixability
 * is a per-rule property, independent of the definite/advisory severity axis.
 */
export const FIXABLE_KINDS: ReadonlySet<FindingKind> = new Set<FindingKind>(['passed-equals-default']);

export interface FixPlan {
  /** The findings whose edits will be applied, in report order. */
  findings: Finding[];
  /** All edits grouped per file, sorted by position. */
  editsByFile: Map<string, FixEdit[]>;
  editCount: number;
}

/**
 * Select the findings safe to auto-fix and group their edits per file.
 * Low-confidence and public-API findings are never fixed — their evidence may
 * be incomplete — nor are findings the caller excludes (e.g. baselined ones).
 */
export function planFixes(
  findings: Finding[],
  isExcluded: (finding: Finding) => boolean = () => false,
): FixPlan {
  const fixable = findings.filter(
    (f) =>
      FIXABLE_KINDS.has(f.kind) &&
      f.fix !== undefined &&
      f.fix.length > 0 &&
      !f.lowConfidence &&
      !f.publicApi &&
      !isExcluded(f),
  );

  const editsByFile = new Map<string, FixEdit[]>();
  let editCount = 0;
  for (const finding of fixable) {
    for (const edit of finding.fix ?? []) {
      const list = editsByFile.get(edit.file);
      if (list) list.push(edit);
      else editsByFile.set(edit.file, [edit]);
      editCount += 1;
    }
  }

  for (const [file, edits] of editsByFile) {
    edits.sort((a, b) => a.start - b.start);
    for (let i = 1; i < edits.length; i++) {
      if (edits[i].start < edits[i - 1].end) {
        throw new Error(`Internal error: overlapping fix edits in ${file}`);
      }
    }
  }

  return { findings: fixable, editsByFile, editCount };
}

export interface AppliedEdit {
  file: string;
  /** 1-based line the edit ends on, in the pre-fix text. */
  line: number;
  /** The removed source text, trimmed for display. */
  removed: string;
}

/**
 * Apply the planned edits to disk; with `dryRun` files are left untouched.
 * Returns one entry per edit for display, sorted by file and line.
 */
export function applyFixes(plan: FixPlan, { dryRun = false } = {}): AppliedEdit[] {
  const applied: AppliedEdit[] = [];
  for (const [file, edits] of plan.editsByFile) {
    const raw = fs.readFileSync(file, 'utf8');
    // Spans are relative to the text as TypeScript read it, which excludes a BOM (U+FEFF).
    const bom = raw.charCodeAt(0) === 0xfeff ? raw[0] : '';
    const text = raw.slice(bom.length);
    if (edits[edits.length - 1].end > text.length) {
      throw new Error(`Fix span out of range in ${file}; the file changed since the analysis ran`);
    }

    let updated = text;
    for (let i = edits.length - 1; i >= 0; i--) {
      const edit = edits[i];
      updated = updated.slice(0, edit.start) + edit.newText + updated.slice(edit.end);
    }
    for (const edit of edits) {
      applied.push({
        file,
        line: text.slice(0, edit.end).split('\n').length,
        removed: text.slice(edit.start, edit.end).trim(),
      });
    }
    if (!dryRun) fs.writeFileSync(file, bom + updated);
  }
  applied.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return applied;
}
