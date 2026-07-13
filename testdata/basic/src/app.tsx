import {
  Alive,
  AlwaysOptional,
  BoolOneSided,
  Dead,
  Indirect,
  Inherit,
  Kids,
  OpaqueTarget,
  SpreadTarget,
  Suppressed,
  TestsOnly,
  UnionMode,
  Wrapped,
} from './components';

const spreadProps: { covered?: string } = { covered: 'x' };
// biome-ignore lint: intentional `any` to exercise the opaque-spread path
const loose = { anything: 'x' } as any;

export function App() {
  const indirectRef = Indirect; // component escapes as a plain value
  void indirectRef;
  return (
    <div>
      <Dead used="value" />
      <Alive opt="provided" />
      <SpreadTarget {...spreadProps} />
      <OpaqueTarget {...loose} />
      <Kids>
        <span />
      </Kids>
      <Inherit />
      <TestsOnly />
      <Wrapped />
      <Indirect />
      <Suppressed />
      {/* Statistical rules need >= 3 qualifying non-test sites (default --min-sites). */}
      <AlwaysOptional always="x" />
      <AlwaysOptional always="y" />
      <AlwaysOptional always="z" />
      <BoolOneSided enabled />
      <BoolOneSided enabled={true} />
      <BoolOneSided enabled />
      <BoolOneSided />
      <UnionMode mode="on" />
      <UnionMode mode="off" />
      <UnionMode mode="on" />
      <UnionMode />
    </div>
  );
}
