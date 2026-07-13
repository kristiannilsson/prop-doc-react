import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/lib/analyze.mjs';

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureTsconfig = path.join(pkgRoot, 'testdata', 'basic', 'tsconfig.json');

// One shared run: building the program is the expensive part.
const result = analyzeProject(fixtureTsconfig);
const findingsFor = (component) => result.findings.filter((f) => f.component === component);

test('flags an optional prop never passed by any parent', () => {
  const [finding, ...rest] = findingsFor('Dead');
  assert.equal(rest.length, 0);
  assert.equal(finding.prop, 'dead');
  assert.equal(finding.kind, 'never');
  assert.equal(finding.renderSites, 1);
  assert.equal(finding.lowConfidence, false);
  assert.match(finding.file.replaceAll('\\', '/'), /testdata\/basic\/src\/components\.tsx$/);
});

test('does not flag an optional prop that some parent passes', () => {
  const problematic = findingsFor('Alive').filter((f) => f.kind === 'never' || f.kind === 'tests-only');
  assert.deepEqual(problematic, []);
});

test('does not flag a required prop', () => {
  // Dead's required prop `used` must not appear even though the tool sees it.
  assert.ok(findingsFor('Dead').every((f) => f.prop !== 'used'));
});

test('credits props covered by a typed spread, flags the rest', () => {
  const props = findingsFor('SpreadTarget')
    .filter((f) => f.kind === 'never')
    .map((f) => f.prop);
  assert.deepEqual(props, ['uncovered']);
});

test('skips a component hit by an untyped (any) spread instead of guessing', () => {
  assert.deepEqual(findingsFor('OpaqueTarget'), []);
  const skipped = result.skipped.find((s) => s.component === 'OpaqueTarget');
  assert.ok(skipped, 'OpaqueTarget should be in the skipped list');
  assert.equal(skipped.spreadIn.length, 1);
});

test('counts JSX nesting as passing the children prop', () => {
  const problematic = findingsFor('Kids').filter((f) => f.kind === 'never' || f.kind === 'tests-only');
  assert.deepEqual(problematic, []);
});

test('ignores optional props inherited from library (declaration-file) types', () => {
  const props = findingsFor('Inherit').map((f) => f.prop);
  assert.deepEqual(props, ['own']);
});

test('classifies props passed only from test files as tests-only', () => {
  const [finding] = findingsFor('TestsOnly');
  assert.equal(finding.prop, 'flag');
  assert.equal(finding.kind, 'tests-only');
  assert.equal(finding.testFiles.length, 1);
  assert.match(finding.testFiles[0].replaceAll('\\', '/'), /harness\.test\.tsx$/);
});

test('sees through memo()-style wrappers', () => {
  const props = findingsFor('Wrapped').map((f) => f.prop);
  assert.deepEqual(props, ['w']);
});

test('marks components that escape as plain values low-confidence', () => {
  const [finding] = findingsFor('Indirect');
  assert.equal(finding.prop, 'maybe');
  assert.equal(finding.lowConfidence, true);
});

test('ignores components with no JSX render sites', () => {
  assert.deepEqual(findingsFor('Unrendered'), []);
});

test('assigns severity by rule family', () => {
  assert.equal(findingsFor('Dead')[0].severity, 'definite');
  assert.equal(findingsFor('TestsOnly')[0].severity, 'definite');
  for (const component of ['AlwaysOptional', 'BoolOneSided', 'UnionMode']) {
    const [finding] = findingsFor(component);
    assert.equal(finding.severity, 'advisory', `${component} should be advisory`);
  }
});

test('statistical rules fire at the default threshold (fixture has 3 qualifying sites each)', () => {
  assert.ok(result.findings.some((f) => f.kind === 'always'));
  assert.ok(result.findings.some((f) => f.kind === 'boolean-never-false'));
  assert.ok(result.findings.some((f) => f.kind === 'union-variant-never'));
});

test('rules option limits which rules run', () => {
  const filtered = analyzeProject(fixtureTsconfig, { rules: ['never'] });
  assert.ok(filtered.findings.length > 0);
  assert.ok(filtered.findings.every((f) => f.kind === 'never'));
});

test('minSites above the fixture site count suppresses statistical rules only', () => {
  const strict = analyzeProject(fixtureTsconfig, { minSites: 4 });
  assert.ok(strict.findings.length > 0);
  assert.ok(strict.findings.every((f) => f.kind === 'never' || f.kind === 'tests-only'));
});

test('excludes components defined in test files by default', () => {
  assert.deepEqual(findingsFor('Harness'), []);
});

test('counts all components with a props parameter, including test-file ones', () => {
  assert.equal(result.componentsAnalyzed, 15);
});

test('a bare prop-doc-ignore comment suppresses every rule for that prop', () => {
  assert.ok(findingsFor('Suppressed').every((f) => f.prop !== 'quiet'));
});

test('a prop-doc-ignore comment naming rules only suppresses those rules', () => {
  const loud = findingsFor('Suppressed').filter((f) => f.prop === 'loud');
  assert.equal(loud.length, 1);
  assert.equal(loud[0].kind, 'never');
});

test('returns findings sorted by file, component, prop', () => {
  const keys = result.findings.map((f) => `${f.file}|${f.component}|${f.prop}`);
  assert.deepEqual(keys, [...keys].sort());
});

test('--include-test-components analyzes test-file components too', () => {
  const withTests = analyzeProject(fixtureTsconfig, { includeTestComponents: true });
  const harness = withTests.findings.filter((f) => f.component === 'Harness');
  assert.equal(harness.length, 1);
  assert.equal(harness[0].prop, 'harnessOnly');
  assert.equal(harness[0].kind, 'never');
});

test('flags optional props always passed by non-test render sites', () => {
  const [finding] = findingsFor('AlwaysOptional').filter((f) => f.kind === 'always');
  assert.ok(finding);
  assert.equal(finding.prop, 'always');
  assert.equal(finding.nonTestRenderSites, 3);
});

test('flags one-sided boolean optional props', () => {
  const [finding] = findingsFor('BoolOneSided').filter((f) => f.kind === 'boolean-never-false');
  assert.ok(finding);
  assert.equal(finding.prop, 'enabled');
});

test('flags dead union variants for optional props', () => {
  const [finding] = findingsFor('UnionMode').filter((f) => f.kind === 'union-variant-never');
  assert.ok(finding);
  assert.equal(finding.prop, 'mode');
  assert.deepEqual(finding.seenVariants, ['off', 'on']);
  assert.deepEqual(finding.missingVariants, ['auto']);
});

test('throws a useful error for a missing tsconfig', () => {
  assert.throws(
    () => analyzeProject(path.join(pkgRoot, 'testdata', 'nope', 'tsconfig.json')),
    /tsconfig/i,
  );
});
