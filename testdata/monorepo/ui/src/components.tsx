// UI package: its components are rendered both here and by the app package.
interface ButtonProps {
  label: string;
  tone?: string; // passed only by the app package -> flagged when ui is analyzed alone
  ghost?: string; // never passed by anyone -> 'never' in every view
}
export function Button(props: ButtonProps) {
  return <button>{props.label}{props.tone}{props.ghost}</button>;
}

export function UiShowcase() {
  return <Button label="in-package render site" />;
}
