import {
  Alive,
  AlwaysOptional,
  BoolOneSided,
  Callbacks,
  Dead,
  DefaultDead,
  DefaultMaybe,
  Indirect,
  Inherit,
  Kids,
  OpaqueBody,
  OpaqueTarget,
  PassedDefault,
  RestForward,
  SameLiteral,
  SpreadTarget,
  Suppressed,
  TestsOnly,
  Unconsumed,
  UnionCollide,
  UnionMode,
  WideChoice,
  Wrapped,
} from './components';

const spreadProps: { covered?: string } = { covered: 'x' };
declare function getMaybeSize(): number | undefined;
const definedSize: number = 5;
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
      <Unconsumed used="u" ignored={1} />
      {/* boolean true, not the string 'true' — a deliberate type error this fixture never typechecks */}
      <UnionCollide flag />
      <UnionCollide flag />
      <UnionCollide flag />
      <Callbacks label="l" onDead={() => {}} onUsed={() => {}} onForwarded={() => {}} />
      <RestForward picked="x" forwarded="y" />
      <OpaqueBody mystery="m" />
      <DefaultDead size={1} />
      <DefaultDead size={2} />
      <DefaultDead size={definedSize} />
      <DefaultMaybe size={getMaybeSize()} />
      <DefaultMaybe size={4} />
      <DefaultMaybe size={5} />
      <SameLiteral tone="quiet" varied="a" />
      <SameLiteral tone="quiet" varied="b" />
      <SameLiteral tone="quiet" varied="c" />
      <PassedDefault size={7} />
      <PassedDefault size={7} />
      <PassedDefault size={7} />
      <WideChoice kind="a" group="g" />
      <WideChoice kind="a" group="g" />
      <WideChoice kind="b" group="g" />
      <WideChoice kind="b" group="g" />
    </div>
  );
}
