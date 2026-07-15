// Fixture components. This project is only ever type-analyzed, never executed,
// so no React import or runtime is needed; diagnostics are irrelevant.
import type { LibLikeProps } from './lib-types';

interface DeadProps {
  used: string;
  dead?: boolean; // never passed anywhere -> 'never' finding
}
export function Dead(props: DeadProps) {
  return <div>{props.used}{String(props.dead)}</div>;
}

interface AliveProps {
  opt?: string; // passed in app.tsx -> no finding
}
export function Alive(props: AliveProps) {
  return <div>{props.opt}</div>;
}

interface SpreadTargetProps {
  covered?: string; // present in the spread's type -> no finding
  uncovered?: number; // not in the spread's type -> 'never' finding
}
export function SpreadTarget(props: SpreadTargetProps) {
  return <div>{props.covered}{props.uncovered}</div>;
}

interface OpaqueTargetProps {
  anything?: string; // render site uses an `any` spread -> component skipped
}
export function OpaqueTarget(props: OpaqueTargetProps) {
  return <div>{props.anything}</div>;
}

interface KidsProps {
  children?: unknown; // passed via JSX nesting -> no finding
}
export function Kids(props: KidsProps) {
  return <div>{String(props.children)}</div>;
}

interface InheritProps extends LibLikeProps {
  own?: string; // declared here -> 'never' finding; libOptional is library code -> ignored
}
export function Inherit(props: InheritProps) {
  return <div>{props.own}</div>;
}

interface TestsOnlyProps {
  flag?: boolean; // passed only from harness.test.tsx -> 'tests-only' finding
}
export function TestsOnly(props: TestsOnlyProps) {
  return <div>{props.flag}</div>;
}

declare function memo<T>(component: T): T;
export const Wrapped = memo(function Wrapped(props: { w?: string }) {
  return <div>{props.w}</div>;
});

interface IndirectProps {
  maybe?: string; // component also escapes as a value -> low-confidence finding
}
export function Indirect(props: IndirectProps) {
  return <div>{props.maybe}</div>;
}

interface UnrenderedProps {
  ghost?: string; // component has no JSX render sites -> out of scope, no finding
}
export function Unrendered(props: UnrenderedProps) {
  return <div>{props.ghost}</div>;
}

interface AlwaysOptionalProps {
  always?: string; // passed from every non-test render site -> 'always' finding
}
export function AlwaysOptional(props: AlwaysOptionalProps) {
  return <div>{props.always}</div>;
}

interface BoolOneSidedProps {
  enabled?: boolean; // only ever passed true (when passed) -> 'boolean-never-false' finding
}
export function BoolOneSided(props: BoolOneSidedProps) {
  return <div>{String(props.enabled)}</div>;
}

interface SuppressedProps {
  // prop-doc-ignore
  quiet?: string;
  loud?: boolean; // prop-doc-ignore always
}
// `quiet` is never passed but fully suppressed -> no finding.
// `loud` is never passed and only suppresses 'always' -> 'never' still fires.
export function Suppressed(props: SuppressedProps) {
  return <div>{String(props.quiet ?? props.loud)}</div>;
}

interface UnionModeProps {
  mode?: 'on' | 'off' | 'auto'; // 'auto' is never passed -> 'union-variant-never' finding
}
export function UnionMode(props: UnionModeProps) {
  return <div>{props.mode}</div>;
}

interface UnconsumedProps {
  used?: string;
  ignored: number; // required and passed, but the body never reads it -> 'unconsumed'
}
export function Unconsumed({ used }: UnconsumedProps) {
  return <div>{used}</div>;
}

interface CallbacksProps {
  label?: string;
  onDead?: () => void; // passed by app.tsx but never referenced -> 'callback-never-invoked'
  onUsed?: () => void; // invoked -> no finding
  onForwarded?: () => void; // forwarded via JSX -> no finding
}
export function Callbacks(props: CallbacksProps) {
  props.onUsed?.();
  return <button onClick={props.onForwarded}>{props.label}</button>;
}

interface RestForwardProps {
  picked?: string;
  forwarded?: string; // captured and forwarded by the referenced rest spread -> no finding
}
export function RestForward({ picked, ...rest }: RestForwardProps) {
  return <div data-picked={picked} {...rest} />;
}

interface DefaultDeadProps {
  size?: number; // every non-test site passes a defined value -> 'default-never-used'
}
export function DefaultDead({ size = 10 }: DefaultDeadProps) {
  return <div>{size}</div>;
}

interface DefaultMaybeProps {
  size?: number; // one site passes a possibly-undefined value -> default may run, no finding
}
export function DefaultMaybe({ size = 10 }: DefaultMaybeProps) {
  return <div>{size}</div>;
}

interface UnionCollideProps {
  // Passed only as boolean `true` (bare attribute); the string variants must
  // NOT be marked as seen just because String(true) === 'true'.
  flag?: 'true' | 'false';
}
export function UnionCollide(props: UnionCollideProps) {
  return <div>{props.flag}</div>;
}

interface SameLiteralProps {
  tone?: string; // every parent passes "quiet" -> 'same-literal' finding
  varied?: string; // parents pass different values -> no finding
}
export function SameLiteral(props: SameLiteralProps) {
  return <div>{props.tone}{props.varied}</div>;
}

interface PassedDefaultProps {
  size?: number; // every site passes exactly the default -> 'passed-equals-default'
}
export function PassedDefault({ size = 7 }: PassedDefaultProps) {
  return <div>{size}</div>;
}

interface WideChoiceProps {
  kind?: string; // declared string but only ever 'a' | 'b' -> 'type-wider-than-usage'
  group: string; // required, but every caller passes "g" -> 'same-literal'
}
export function WideChoice(props: WideChoiceProps) {
  return <div>{props.kind}{props.group}</div>;
}

interface OpaqueBodyProps {
  mystery?: string; // props object escapes -> consumption rules stay silent
}
export function OpaqueBody(props: OpaqueBodyProps) {
  return <div>{JSON.stringify(props)}</div>;
}

interface FoldReplaceProps {
  tone?: string; // every site passes "calm" but the default says "loud" -> 'same-literal'; the fix folds the default
}
export function FoldReplace({ tone = 'loud' }: FoldReplaceProps) {
  return <div>{tone}</div>;
}

interface FoldInsertProps {
  pad?: number; // every site passes 4 and there is no default -> 'same-literal'; the fix inserts one
}
export function FoldInsert({ pad }: FoldInsertProps) {
  return <div>{pad}</div>;
}

interface DropDeadProps {
  keep?: string;
  vestigial?: number; // never passed AND never consumed -> whole-prop removal deletes the declaration
}
export function DropDead({ keep }: DropDeadProps) {
  return <div>{keep}</div>;
}

interface TrimBindingProps {
  a?: string;
  stale?: string; // destructured but unreferenced and never passed -> removal also deletes the binding
}
export function TrimBinding({ a, stale }: TrimBindingProps) {
  return <div>{a}</div>;
}
