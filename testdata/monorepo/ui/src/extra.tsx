// This file is NOT imported by the app package: it only enters the program
// when the ui tsconfig itself is loaded (directly or via a project reference).
interface UnreferencedProps {
  lonely?: string; // never passed -> 'never', visible only with whole-program view
}
export function Unreferenced(props: UnreferencedProps) {
  return <div>{props.lonely}</div>;
}

export function ExtraShowcase() {
  return <Unreferenced />;
}
