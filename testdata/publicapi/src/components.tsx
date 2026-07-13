// A publishable package (package.json without "private": true): components
// re-exported from the entry point may have consumers outside this program.
interface ExportedProps {
  title?: string; // never passed internally, but external consumers are invisible -> demoted
}
export function Exported(props: ExportedProps) {
  return <div>{props.title}</div>;
}

interface InternalProps {
  hidden?: string; // not part of the public API -> finding gates as usual
}
export function Internal(props: InternalProps) {
  return <div>{props.hidden}</div>;
}

export function Showcase() {
  return (
    <div>
      <Exported />
      <Internal />
    </div>
  );
}
