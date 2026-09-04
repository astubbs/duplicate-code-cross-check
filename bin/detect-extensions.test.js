'use strict';

/**
 * Tests for bin/detect-extensions.sh.
 *
 * Every fixture name here is a real path shape that broke the `sed 's/.*\.//'` pipeline this script
 * replaces, taken from the extension list a live run produced on astubbs/parallel-consumer. The
 * assertions are therefore a regression guard on specific observed output, not invented edge cases.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'detect-extensions.sh');

/** Build a throwaway tree of empty files and return `{ counts, ignored }` from the script. */
function detect(relativePaths) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-ext-'));
  try {
    for (const rel of relativePaths) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '');
    }
    const run = spawnSync('bash', [SCRIPT, root], { encoding: 'utf8' });
    assert.strictEqual(run.status, 0, `script failed: ${run.stderr}`);

    const counts = {};
    for (const line of run.stdout.split('\n').filter(Boolean)) {
      const [count, ext] = line.trim().split(/\s+/);
      counts[ext] = Number(count);
    }
    return { counts, ignored: run.stderr.trim() };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('counts real extensions, most common first', () => {
  const { counts } = detect(['a.java', 'b.java', 'c.md']);
  assert.deepStrictEqual(counts, { java: 2, md: 1 });
});

test('a dot in a directory name is not an extension', () => {
  // `pmd-bin-7.9.0/bin/pmd` used to be reported as the extension `0/bin/pmd`.
  const { counts } = detect(['pmd-bin-7.9.0/bin/pmd', 'pmd-bin-7.9.0/LICENSE']);
  assert.deepStrictEqual(counts, {});
});

test('an extensionless file at any depth contributes nothing', () => {
  // These produced `/mvnw`, `/LICENSE`, `/NOTICE`, `github/CODEOWNERS`, `githooks/pre-commit`.
  const { counts } = detect(['mvnw', 'LICENSE', 'NOTICE', '.github/CODEOWNERS', '.githooks/pre-commit']);
  assert.deepStrictEqual(counts, {});
});

test('a dot-file with no extension is not an extension', () => {
  // These produced `gitignore`, `gitmessage`, `editorconfig`, `config`.
  const { counts } = detect(['.gitignore', '.gitmessage', '.editorconfig']);
  assert.deepStrictEqual(counts, {});
});

test('a dot-file that does have an extension keeps it', () => {
  const { counts } = detect(['.eslintrc.json', '.mvn/maven.config']);
  assert.deepStrictEqual(counts, { json: 1, config: 1 });
});

test('a dotted file name is not a 21-character extension', () => {
  // A JUnit service-registration file produced the extension `TestExecutionListener`.
  const { counts } = detect([
    'src/test/resources/META-INF/services/org.junit.platform.launcher.TestExecutionListener',
  ]);
  assert.deepStrictEqual(counts, {});
});

test('archives and binaries are dropped, and say so on stderr', () => {
  const { counts, ignored } = detect(['lib/pmd.jar', 'dist.zip', 'logo.png', 'Real.java']);
  assert.deepStrictEqual(counts, { java: 1 });
  assert.match(ignored, /Ignored non-source extensions:/);
  for (const ext of ['jar', 'zip', 'png']) {
    assert.match(ignored, new RegExp(`\\b${ext}\\b`), `expected ${ext} to be reported as ignored`);
  }
});

test('a trailing dot is not an empty extension', () => {
  const { counts } = detect(['weird.']);
  assert.deepStrictEqual(counts, {});
});

test('.git, node_modules and vendor are not scanned', () => {
  const { counts } = detect([
    '.git/config.java',
    'node_modules/pkg/index.java',
    'vendor/dep/thing.java',
    'src/Kept.java',
  ]);
  assert.deepStrictEqual(counts, { java: 1 });
});

test('extension case is preserved but denylisting is case-insensitive', () => {
  const { counts } = detect(['Photo.PNG', 'Header.H']);
  assert.deepStrictEqual(counts, { H: 1 });
});

test('no arguments is a usage error', () => {
  assert.throws(
    () => execFileSync('bash', [SCRIPT], { encoding: 'utf8', stdio: 'pipe' }),
    (err) => err.status === 2,
  );
});
