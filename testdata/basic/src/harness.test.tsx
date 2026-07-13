import { TestsOnly } from './components';

interface HarnessProps {
  harnessOnly?: string; // defined in a test file -> excluded unless --include-test-components
}
export function Harness(props: HarnessProps) {
  return (
    <div>
      {props.harnessOnly}
      <TestsOnly flag />
    </div>
  );
}

export function RenderIt() {
  return <Harness />;
}
