import fs from 'node:fs';
import type { Finding, FindingKind, FixEdit } from './analyzer/types.mjs';

export const FIXABLE_KINDS: ReadonlySet<FindingKind> = new Set<FindingKind>([
  'passed-equals-default',
  'same-literal',
  'type-wider-than-usage',
  'union-variant-never',
  'never',
  'unconsumed',
  'callback-never-invoked',
]);

export interface FixPlan {
  findings: Finding[];
  editsByFile: Map<string, FixEdit[]>;
  editCount: number;
}

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

  // Two findings may target the same source range: accept in report order,
  // skip overlaps; the skipped one is re-evaluated by the post-fix re-run.
  const accepted: Finding[] = [];
  const editsByFile = new Map<string, FixEdit[]>();
  let editCount = 0;
  const overlaps = (edit: FixEdit): boolean =>
    (editsByFile.get(edit.file) ?? []).some((a) => edit.start < a.end && a.start < edit.end);

  for (const finding of fixable) {
    const edits = finding.fix ?? [];
    if (edits.some(overlaps)) continue;
    accepted.push(finding);
    for (const edit of edits) {
      const list = editsByFile.get(edit.file);
      if (list) list.push(edit);
      else editsByFile.set(edit.file, [edit]);
      editCount += 1;
    }
  }

  for (const edits of editsByFile.values()) {
    edits.sort((a, b) => a.start - b.start);
  }

  return { findings: accepted, editsByFile, editCount };
}

export interface AppliedEdit {
  file: string;
  line: number;
  removed: string;
  newText: string;
}

export function applyFixes(plan: FixPlan, { dryRun = false } = {}): AppliedEdit[] {
  const applied: AppliedEdit[] = [];
  for (const [file, edits] of plan.editsByFile) {
    const raw = fs.readFileSync(file, 'utf8');
    // Spans are relative to the text as TypeScript read it, which excludes a BOM.
    const bom = raw.codePointAt(0) === 0xfeff ? raw[0] : '';
    const text = raw.slice(bom.length);
    if ((edits.at(-1) as FixEdit).end > text.length) {
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
        newText: edit.newText,
      });
    }
    if (!dryRun) fs.writeFileSync(file, bom + updated);
  }
  applied.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return applied;
}
