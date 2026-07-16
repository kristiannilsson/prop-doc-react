import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(pkgRoot, 'dist', 'bin', 'cli.mjs');
const fixtureTsconfig = path.join(pkgRoot, 'testdata', 'basic', 'tsconfig.json');

const run = (...args) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: pkgRoot });

test('--json emits parseable findings and exits 1 on definite findings', () => {
  const { status, stdout } = run(fixtureTsconfig, '--json');
  assert.equal(status, 1);
  const report = JSON.parse(stdout);
  assert.ok(report.findings.length >= 5);
  assert.ok(report.findings.every((f) => f.component && f.prop && f.kind && f.file));
  assert.equal(report.skippedForOpaqueSpread.length, 1);
  assert.equal(typeof report.componentsAnalyzed, 'number');
  assert.ok(report.findings.every((f) => !path.isAbsolute(f.file) && !f.file.includes('\\')));
});

test('human output groups findings per component', () => {
  const { status, stdout } = run(fixtureTsconfig);
  assert.equal(status, 1);
  assert.match(stdout, /Definite Findings \(/);
  assert.match(stdout, /Advisory Findings \(/);
  assert.match(stdout, /<Dead> — 1 render site\(s\)/);
  assert.match(stdout, /dead\s+\[never\]\s+never passed by any parent/);
  assert.match(stdout, /flag\s+\[tests-only\]\s+only passed from test\/story files/);
  assert.match(stdout, /always\s+\[always\]\s+passed by every non-test parent/);
  assert.match(stdout, /mode\s+\[union-variant-never\]\s+union variant\(s\) never passed: auto/);
  assert.match(stdout, /<Indirect>.*\[low confidence/);
  assert.match(stdout, /definite\)\./);
});

test('--verbose lists components skipped for opaque spreads', () => {
  const { stdout } = run(fixtureTsconfig, '--verbose');
  assert.match(stdout, /Skipped Components \(opaque spread may pass any prop\)/);
  assert.match(stdout, /<OpaqueTarget>/);
});

test('--help exits 0 with usage', () => {
  const { status, stdout } = run('--help');
  assert.equal(status, 0);
  assert.match(stdout, /Usage: prop-doc/);
});

test('--rules limits output, and advisory-only findings exit 0', () => {
  const { status, stdout } = run(fixtureTsconfig, '--rules=always', '--json');
  const report = JSON.parse(stdout);
  assert.ok(report.findings.length > 0);
  assert.ok(report.findings.every((f) => f.kind === 'always' && f.severity === 'advisory'));
  assert.equal(status, 0);
});

test('--min-sites raises the statistical threshold without touching definite rules', () => {
  const { status, stdout } = run(fixtureTsconfig, '--min-sites', '99', '--json');
  const report = JSON.parse(stdout);
  assert.ok(report.findings.length > 0);
  assert.ok(report.findings.every((f) => f.severity === 'definite'));
  assert.equal(status, 1);
});

test('invalid --rules and --min-sites values exit 2', () => {
  assert.equal(run(fixtureTsconfig, '--rules=bogus').status, 2);
  assert.equal(run(fixtureTsconfig, '--min-sites=0').status, 2);
  assert.equal(run(fixtureTsconfig, '--min-sites').status, 2);
});

test('--write-baseline then --baseline hides existing findings and exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-doc-baseline-'));
  const baseline = path.join(dir, 'baseline.json');
  try {
    const write = run(fixtureTsconfig, '--baseline', baseline, '--write-baseline');
    assert.equal(write.status, 0);
    assert.match(write.stdout, /Wrote \d+ finding\(s\)/);
    const recorded = JSON.parse(fs.readFileSync(baseline, 'utf8'));
    assert.equal(recorded.version, 1);
    assert.ok(recorded.findings.length >= 5);

    const gated = run(fixtureTsconfig, '--baseline', baseline);
    assert.equal(gated.status, 0);
    assert.match(gated.stdout, /baselined finding\(s\) hidden/);
    assert.match(gated.stdout, /0 finding\(s\)/);

    const asJson = run(fixtureTsconfig, '--baseline', baseline, '--json');
    const report = JSON.parse(asJson.stdout);
    assert.ok(report.findings.length > 0);
    assert.ok(report.findings.every((f) => f.baselined === true));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty baseline still fails on definite findings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-doc-baseline-'));
  const baseline = path.join(dir, 'baseline.json');
  try {
    fs.writeFileSync(baseline, JSON.stringify({ version: 1, findings: [] }));
    assert.equal(run(fixtureTsconfig, '--baseline', baseline).status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or malformed baseline file exits 2', () => {
  assert.equal(run(fixtureTsconfig, '--baseline', 'does-not-exist.json').status, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-doc-baseline-'));
  const baseline = path.join(dir, 'baseline.json');
  try {
    fs.writeFileSync(baseline, 'not json');
    assert.equal(run(fixtureTsconfig, '--baseline', baseline).status, 2);
    fs.writeFileSync(baseline, JSON.stringify({ version: 99, findings: [] }));
    assert.equal(run(fixtureTsconfig, '--baseline', baseline).status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const publicApiTsconfig = path.join(pkgRoot, 'testdata', 'publicapi', 'tsconfig.json');

test('public-API findings do not gate the exit code; --assume-internal restores the gate', () => {
  const demoted = run(publicApiTsconfig, '--rules', 'never', '--json');
  const report = JSON.parse(demoted.stdout);
  const exported = report.findings.find((f) => f.component === 'Exported');
  assert.equal(exported.publicApi, true);
  const human = run(publicApiTsconfig, '--rules', 'never');
  assert.match(human.stdout, /\[public API: may have consumers outside this program\]/);

  const strict = run(publicApiTsconfig, '--rules', 'never', '--assume-internal', '--json');
  const strictReport = JSON.parse(strict.stdout);
  assert.ok(strictReport.findings.every((f) => f.publicApi === false));
});

test('--fix --dry-run previews edits without touching files, --fix applies and re-analyzes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-doc-fix-'));
  try {
    fs.cpSync(path.join(pkgRoot, 'testdata', 'basic'), dir, { recursive: true });
    const tsconfig = path.join(dir, 'tsconfig.json');
    const appFile = path.join(dir, 'src', 'app.tsx');
    const before = fs.readFileSync(appFile, 'utf8');
    assert.match(before, /<PassedDefault size=\{7\} \/>/);

    const dry = run(tsconfig, '--fix', '--dry-run');
    assert.match(dry.stdout, /Planned Fixes \(no files changed\)/);
    assert.match(dry.stdout, /removed size=\{7\}/);
    assert.equal(fs.readFileSync(appFile, 'utf8'), before);
    assert.match(dry.stdout, /\[passed-equals-default\]/);

    const fixed = run(tsconfig, '--fix');
    assert.match(fixed.stdout, /Applied Fixes/);
    const after = fs.readFileSync(appFile, 'utf8');
    assert.ok(!after.includes('<PassedDefault size={7} />'));
    assert.match(after, /<PassedDefault \/>/);
    const comps = fs.readFileSync(path.join(dir, 'src', 'components.tsx'), 'utf8');
    assert.match(comps, /kind\?: 'a' \| 'b';/);
    assert.match(comps, /mode\?: 'on' \| 'off';/);
    assert.match(comps, /\{ tone = 'calm' \}/);
    assert.match(comps, /\{ pad = 4 \}/);
    assert.ok(!after.includes('tone="calm"'));
    assert.ok(!after.includes('pad={4}'));
    assert.ok(!comps.includes('vestigial'));
    assert.ok(!comps.includes('stale'));
    assert.ok(!comps.includes('onDead'));
    assert.ok(!comps.includes('ignored: number'));
    assert.match(comps, /TrimBinding\(\{ a \}: TrimBindingProps\)/);
    assert.ok(!after.includes('onDead'));
    assert.ok(!after.includes('ignored={1}'));
    assert.ok(!fixed.stdout.includes('[passed-equals-default]'));
    assert.ok(!fixed.stdout.includes('[type-wider-than-usage]'));
    assert.ok(!fixed.stdout.includes('[unconsumed]'));
    assert.ok(!fixed.stdout.includes('[callback-never-invoked]'));
    assert.match(fixed.stdout, /size\s+\[never\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--fix --json reports the applied edits and per-finding fix spans', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prop-doc-fix-'));
  try {
    fs.cpSync(path.join(pkgRoot, 'testdata', 'basic'), dir, { recursive: true });
    const tsconfig = path.join(dir, 'tsconfig.json');

    const dry = run(tsconfig, '--fix', '--dry-run', '--json');
    const report = JSON.parse(dry.stdout);
    assert.equal(report.fixes.dryRun, true);
    assert.ok(report.fixes.findingsFixed >= 1);
    assert.ok(report.fixes.edits.length >= 3);
    assert.ok(report.fixes.edits.every((e) => e.file && e.line > 0 && (e.removed || e.newText)));
    const finding = report.findings.find((f) => f.kind === 'passed-equals-default');
    assert.equal(finding.fix.length, 3);
    assert.ok(
      finding.fix.every((e) => Number.isInteger(e.start) && e.end > e.start && e.newText === ''),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--dry-run without --fix and --fix with --write-baseline exit 2', () => {
  assert.equal(run(fixtureTsconfig, '--dry-run').status, 2);
  assert.equal(run(fixtureTsconfig, '--fix', '--write-baseline').status, 2);
});

test('unknown flags exit 2', () => {
  const { status, stderr } = run(fixtureTsconfig, '--nope');
  assert.equal(status, 2);
  assert.match(stderr, /Unknown option/);
});

test('missing tsconfig exits 2 with the error on stderr', () => {
  const { status, stderr } = run('does-not-exist/tsconfig.json');
  assert.equal(status, 2);
  assert.ok(stderr.trim().length > 0);
});
