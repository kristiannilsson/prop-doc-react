import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  // CLI relativizes paths and normalizes separators
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
  assert.match(stdout, /enabled\s+\[bool-never-false\]\s+boolean is only ever passed true when provided/);
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
