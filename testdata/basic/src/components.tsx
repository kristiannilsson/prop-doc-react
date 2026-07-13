// Fixture components. This project is only ever type-analyzed, never executed,
// so no React import or runtime is needed; diagnostics are irrelevant.
import type { LibLikeProps } from './lib-types';

interface DeadProps {
  used: string;
  dead?: boolean; // never passed anywhere -> 'never' finding
}
export function Dead(props: DeadProps) {
  return <div>{props.used}</div>;
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
  return <div>{props.covered}</div>;
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

interface UnionModeProps {
  mode?: 'on' | 'off' | 'auto'; // 'auto' is never passed -> 'union-variant-never' finding
}
export function UnionMode(props: UnionModeProps) {
  return <div>{props.mode}</div>;
}
