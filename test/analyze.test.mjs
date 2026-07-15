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

const STATISTICAL_KINDS = [
  'always',
  'boolean-never-true',
  'boolean-never-false',
  'union-variant-never',
  'default-never-used',
  'same-literal',
  'passed-equals-default',
  'type-wider-than-usage',
];

test('minSites above the fixture site count suppresses statistical rules only', () => {
  const strict = analyzeProject(fixtureTsconfig, { minSites: 5 });
  assert.ok(strict.findings.length > 0);
  assert.ok(strict.findings.every((f) => !STATISTICAL_KINDS.includes(f.kind)));
});

test('excludes components defined in test files by default', () => {
  assert.deepEqual(findingsFor('Harness'), []);
});

test('counts all components with a props parameter, including test-file ones', () => {
  assert.equal(result.componentsAnalyzed, 29);
});

test('unconsumed carries a whole-prop removal fix when callsite values are side-effect-free', () => {
  const [finding] = findingsFor('Unconsumed');
  assert.equal(finding.kind, 'unconsumed');
  assert.equal(finding.fix.length, 2); // declaration line + literal callsite attribute
  assert.ok(finding.fix.every((e) => e.newText === ''));
});

test('callback-never-invoked carries a removal fix for inline-arrow callsites', () => {
  const [finding] = findingsFor('Callbacks');
  assert.equal(finding.kind, 'callback-never-invoked');
  assert.equal(finding.fix.length, 2); // declaration line + arrow-function attribute
});

test('never carries a removal fix only when the body ignores the prop', () => {
  assert.equal(findingsFor('Dead')[0].fix, undefined); // body reads props.dead
  const never = findingsFor('DropDead').find((f) => f.kind === 'never');
  assert.equal(never.fix.length, 1); // declaration line only
});

test('removing a destructured-but-unreferenced prop also deletes the binding element', () => {
  const finding = findingsFor('TrimBinding').find((f) => f.kind === 'unconsumed');
  assert.equal(finding.fix.length, 2); // declaration line + binding element
});

test('flags props always passed the same literal, quoting strings, sparing varied props', () => {
  const sameLiteral = findingsFor('SameLiteral').filter((f) => f.kind === 'same-literal');
  assert.equal(sameLiteral.length, 1);
  assert.equal(sameLiteral[0].prop, 'tone');
  assert.equal(sameLiteral[0].literalValue, '"quiet"');
  assert.equal(sameLiteral[0].severity, 'advisory');
});

test('flags callsites that always pass exactly the destructuring default', () => {
  const kinds = findingsFor('PassedDefault').map((f) => f.kind);
  assert.ok(kinds.includes('passed-equals-default'));
  const finding = findingsFor('PassedDefault').find((f) => f.kind === 'passed-equals-default');
  assert.equal(finding.literalValue, '7');
  // The more specific rule wins over the overlapping generic ones.
  assert.ok(!kinds.includes('default-never-used'));
  assert.ok(!kinds.includes('same-literal'));
});

test('passed-equals-default carries one deletion edit per verified callsite attribute', () => {
  const finding = findingsFor('PassedDefault').find((f) => f.kind === 'passed-equals-default');
  assert.equal(finding.fix.length, 3);
  for (const edit of finding.fix) {
    assert.match(edit.file.replaceAll('\\', '/'), /testdata\/basic\/src\/app\.tsx$/);
    assert.ok(Number.isInteger(edit.start) && edit.end > edit.start);
    assert.equal(edit.newText, '');
  }
  // Findings without a fixer stay span-free.
  assert.equal(findingsFor('Dead')[0].fix, undefined);
});

test('type-wider-than-usage carries a type-narrowing edit', () => {
  const finding = findingsFor('WideChoice').find((f) => f.kind === 'type-wider-than-usage');
  assert.equal(finding.fix.length, 1);
  assert.equal(finding.fix[0].newText, "'a' | 'b'");
  assert.match(finding.fix[0].file.replaceAll('\\', '/'), /components\.tsx$/);
});

test('union-variant-never carries a union-rewrite edit keeping the seen variants', () => {
  const finding = findingsFor('UnionMode').find((f) => f.kind === 'union-variant-never');
  assert.equal(finding.fix.length, 1);
  assert.equal(finding.fix[0].newText, "'on' | 'off'");
});

test('union-variant-never attaches no fix when no variant was verifiably seen', () => {
  const finding = findingsFor('UnionCollide').find((f) => f.kind === 'union-variant-never');
  assert.equal(finding.fix, undefined);
});

test('same-literal fix replaces an existing dead default and deletes every attribute', () => {
  const finding = findingsFor('FoldReplace').find((f) => f.kind === 'same-literal');
  assert.equal(finding.fix.length, 4);
  const [defaultEdit, ...deletions] = finding.fix;
  assert.equal(defaultEdit.newText, "'calm'");
  assert.ok(defaultEdit.end > defaultEdit.start, 'replaces the existing default expression');
  assert.ok(deletions.every((e) => e.newText === ''));
});

test('same-literal fix inserts a default when none exists', () => {
  const finding = findingsFor('FoldInsert').find((f) => f.kind === 'same-literal');
  const defaultEdit = finding.fix.find((e) => e.newText !== '');
  assert.equal(defaultEdit.newText, ' = 4');
  assert.equal(defaultEdit.start, defaultEdit.end, 'zero-length span marks an insertion');
});

test('same-literal attaches no fix without a destructuring target or for required props', () => {
  // SameLiteral reads props.tone without destructuring; WideChoice.group is required.
  assert.equal(findingsFor('SameLiteral').find((f) => f.kind === 'same-literal').fix, undefined);
  assert.equal(findingsFor('WideChoice').find((f) => f.kind === 'same-literal').fix, undefined);
});

test('flags wide string props whose observed values are a small repeated set', () => {
  const finding = findingsFor('WideChoice').find((f) => f.kind === 'type-wider-than-usage');
  assert.ok(finding);
  assert.equal(finding.prop, 'kind');
  assert.deepEqual(finding.observedValues, ['"a"', '"b"']);
});

test('same-literal fires for required props too', () => {
  const finding = findingsFor('WideChoice').find((f) => f.kind === 'same-literal');
  assert.ok(finding);
  assert.equal(finding.prop, 'group');
  assert.equal(finding.literalValue, '"g"');
});

test('type-wider-than-usage does not fire on union-typed or varied props', () => {
  assert.ok(!findingsFor('UnionMode').some((f) => f.kind === 'type-wider-than-usage'));
  assert.ok(!findingsFor('SameLiteral').some((f) => f.kind === 'type-wider-than-usage'));
});

test('same-literal leaves booleans to the one-sided boolean rules', () => {
  const kinds = findingsFor('BoolOneSided').map((f) => f.kind);
  assert.ok(!kinds.includes('same-literal'));
  assert.ok(kinds.includes('boolean-never-false'));
});

test('boolean true does not count as the string variant "true"', () => {
  const [finding] = findingsFor('UnionCollide').filter((f) => f.kind === 'union-variant-never');
  assert.ok(finding);
  assert.deepEqual(finding.seenVariants, []);
  assert.deepEqual(finding.missingVariants, ['false', 'true']);
});

test('classifies test files relative to the tsconfig directory, not the absolute path', () => {
  // This fixture lives under testdata/fixtures/, which the test-file regex
  // matches; only paths *inside* the project may trigger classification.
  const mini = analyzeProject(path.join(pkgRoot, 'testdata', 'fixtures', 'mini', 'tsconfig.json'));
  const kinds = mini.findings.map((f) => `${f.component}.${f.prop}:${f.kind}`);
  assert.ok(kinds.includes('Mini.dead:never'), `expected a finding, got [${kinds.join(', ')}]`);
});

test('flags props (required included) the body never reads or forwards', () => {
  const [finding, ...rest] = findingsFor('Unconsumed');
  assert.equal(rest.length, 0);
  assert.equal(finding.prop, 'ignored');
  assert.equal(finding.kind, 'unconsumed');
  assert.equal(finding.severity, 'definite');
});

test('flags callbacks passed by parents but never referenced, sparing invoked and forwarded ones', () => {
  const [finding, ...rest] = findingsFor('Callbacks');
  assert.equal(rest.length, 0);
  assert.equal(finding.prop, 'onDead');
  assert.equal(finding.kind, 'callback-never-invoked');
  assert.equal(finding.severity, 'definite');
});

test('credits props forwarded through a referenced rest spread', () => {
  assert.deepEqual(findingsFor('RestForward'), []);
});

test('consumption rules stay silent when the props object escapes whole', () => {
  assert.deepEqual(findingsFor('OpaqueBody'), []);
});

test('flags destructuring defaults that no non-test site can exercise', () => {
  const kinds = findingsFor('DefaultDead').map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['always', 'default-never-used']);
});

test('spares destructuring defaults when a site may pass undefined', () => {
  const kinds = findingsFor('DefaultMaybe').map((f) => f.kind);
  assert.ok(!kinds.includes('default-never-used'));
});

test('always does not fire when a site passes a possibly-undefined value', () => {
  // DefaultMaybe's `size` is passed at every site, but one value is typed
  // `number | undefined` — the prop is only conditionally provided.
  const kinds = findingsFor('DefaultMaybe').map((f) => f.kind);
  assert.ok(!kinds.includes('always'));
  // Control: DefaultDead passes only defined values and still fires.
  assert.ok(findingsFor('DefaultDead').some((f) => f.kind === 'always'));
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

const uiTsconfig = path.join(pkgRoot, 'testdata', 'monorepo', 'ui', 'tsconfig.json');
const appTsconfig = path.join(pkgRoot, 'testdata', 'monorepo', 'app', 'tsconfig.json');

test('a package analyzed alone misses render sites in sibling packages', () => {
  const uiAlone = analyzeProject(uiTsconfig);
  const buttonProps = uiAlone.findings.filter((f) => f.component === 'Button').map((f) => f.prop);
  // Only the app passes `tone`, and ui alone can't see the app.
  assert.ok(buttonProps.includes('tone'));
});

test('multiple tsconfig paths merge into one program with cross-package visibility', () => {
  const both = analyzeProject([uiTsconfig, appTsconfig]);
  assert.ok(!both.findings.some((f) => f.prop === 'tone'), 'tone is passed by the app');
  assert.ok(
    both.findings.some((f) => f.component === 'Button' && f.prop === 'ghost' && f.kind === 'never'),
    'ghost is never passed anywhere',
  );
});

test('project references are followed automatically', () => {
  const app = analyzeProject(appTsconfig);
  // `tone` is passed right there in the app.
  assert.ok(!app.findings.some((f) => f.prop === 'tone'));
  // extra.tsx is never imported by the app; only the followed reference to
  // the ui tsconfig brings it into the program.
  assert.ok(app.findings.some((f) => f.component === 'Unreferenced' && f.prop === 'lonely' && f.kind === 'never'));
});

const publicApiTsconfig = path.join(pkgRoot, 'testdata', 'publicapi', 'tsconfig.json');

test('components exported from a package entry point are marked publicApi', () => {
  const lib = analyzeProject(publicApiTsconfig);
  const exported = lib.findings.find((f) => f.component === 'Exported' && f.prop === 'title');
  const internal = lib.findings.find((f) => f.component === 'Internal' && f.prop === 'hidden');
  assert.ok(exported && internal, 'both never-findings should exist');
  assert.equal(exported.publicApi, true);
  assert.equal(internal.publicApi, false);
});

test('assumeInternal disables public-API demotion', () => {
  const lib = analyzeProject(publicApiTsconfig, { assumeInternal: true });
  assert.ok(lib.findings.every((f) => f.publicApi === false));
});

test('a project without a package.json next to its tsconfig is all internal', () => {
  // The basic fixture has no package.json in testdata/basic.
  assert.ok(result.findings.every((f) => f.publicApi === false));
});

test('throws a useful error for a missing tsconfig', () => {
  assert.throws(
    () => analyzeProject(path.join(pkgRoot, 'testdata', 'nope', 'tsconfig.json')),
    /tsconfig/i,
  );
});
