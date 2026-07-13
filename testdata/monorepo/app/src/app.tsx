import { Button } from '../../ui/src/components';

// The app package is the only place that passes Button's `tone` prop: without
// whole-program visibility, analyzing ui alone misreports it as never passed.
export function App() {
  return <Button label="from app" tone="dark" />;
}
