// This fixture deliberately lives under a `testdata/fixtures/` path: test-file
// classification must be relative to the tsconfig directory, so a repo that
// itself sits under a /fixtures/ (or /test/) segment is not wholesale
// misclassified as test code.
interface MiniProps {
  used: string;
  dead?: boolean; // never passed anywhere -> 'never' finding
}
export function Mini(props: MiniProps) {
  return <div>{props.used}{String(props.dead)}</div>;
}

export function MiniApp() {
  return <Mini used="x" />;
}
