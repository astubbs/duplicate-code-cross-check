const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  readConfig,
  contentHash,
  relPath,
  countTotalLines,
  deltaEmoji,
  fmtDelta,
  parseCpdXml,
  cpdStats,
  cpdNewClones,
  loadJscpd,
  jscpdNewClones,
  checkFail,
  renderEngineSection,
} = require('./report.js');

// ── contentHash ──────────────────────────────────────────────────────

describe('contentHash', () => {
  it('returns consistent hash for same input', () => {
    assert.equal(contentHash('hello'), contentHash('hello'));
  });

  it('returns different hash for different input', () => {
    assert.notEqual(contentHash('hello'), contentHash('world'));
  });

  it('handles null/undefined gracefully', () => {
    assert.equal(contentHash(null), contentHash(''));
    assert.equal(contentHash(undefined), contentHash(''));
  });
});

// ── relPath ──────────────────────────────────────────────────────────

describe('relPath', () => {
  it('strips workspace prefix', () => {
    assert.equal(relPath('/home/runner/work/repo/src/file.js', '/home/runner/work/repo'), 'src/file.js');
  });

  it('strips workspace prefix with trailing slash', () => {
    assert.equal(relPath('/home/runner/work/repo/src/file.js', '/home/runner/work/repo/'), 'src/file.js');
  });

  it('returns path unchanged when workspace does not match', () => {
    assert.equal(relPath('/other/path/file.js', '/home/runner/work/repo'), '/other/path/file.js');
  });

  it('returns falsy input unchanged', () => {
    assert.equal(relPath(null, '/workspace'), null);
    assert.equal(relPath(undefined, '/workspace'), undefined);
    assert.equal(relPath('', '/workspace'), '');
  });
});

// ── deltaEmoji ───────────────────────────────────────────────────────

describe('deltaEmoji', () => {
  it('returns neutral for zero', () => {
    assert.equal(deltaEmoji(0, false), ':heavy_minus_sign:');
    assert.equal(deltaEmoji(0, true), ':heavy_minus_sign:');
  });

  it('returns positive emojis for improvements (negative delta)', () => {
    assert.equal(deltaEmoji(-25, false), ':heart:');
    assert.equal(deltaEmoji(-10, false), ':thumbsup:');
    assert.equal(deltaEmoji(-1, false), ':slightly_smiling_face:');
  });

  it('returns concern emojis for regressions (positive delta)', () => {
    assert.equal(deltaEmoji(25, false), ':face_with_raised_eyebrow:');
    assert.equal(deltaEmoji(10, false), ':face_with_monocle:');
    assert.equal(deltaEmoji(1, false), ':face_with_diagonal_mouth:');
  });

  it('uses percentage thresholds when isPercentage is true', () => {
    assert.equal(deltaEmoji(-2, true), ':heart:');
    assert.equal(deltaEmoji(-0.5, true), ':thumbsup:');
    assert.equal(deltaEmoji(-0.05, true), ':slightly_smiling_face:');
    assert.equal(deltaEmoji(2, true), ':face_with_raised_eyebrow:');
    assert.equal(deltaEmoji(0.5, true), ':face_with_monocle:');
    assert.equal(deltaEmoji(0.05, true), ':face_with_diagonal_mouth:');
  });
});

// ── fmtDelta ─────────────────────────────────────────────────────────

describe('fmtDelta', () => {
  it('formats zero', () => {
    assert.equal(fmtDelta(0), ':heavy_minus_sign: 0');
  });

  it('formats positive delta with plus sign', () => {
    const result = fmtDelta(5, '%');
    assert.ok(result.includes('+5%'));
  });

  it('formats negative delta', () => {
    const result = fmtDelta(-3, '%');
    assert.ok(result.includes('-3%'));
  });

  it('works without suffix', () => {
    const result = fmtDelta(10);
    assert.ok(result.includes('+10'));
    assert.ok(!result.includes('%'));
  });
});

// ── cpdStats ─────────────────────────────────────────────────────────

describe('cpdStats', () => {
  it('returns null for null report', () => {
    assert.equal(cpdStats(null, 1000), null);
  });

  it('calculates stats for empty duplicates', () => {
    const result = cpdStats({ duplicates: [] }, 1000);
    assert.deepEqual(result, { clones: 0, duplicatedLines: 0, percentage: 0 });
  });

  it('calculates stats correctly', () => {
    const report = {
      duplicates: [
        { lines: 10, files: [{ name: 'a.js' }, { name: 'b.js' }], fragment: 'code' },
        { lines: 5, files: [{ name: 'c.js' }], fragment: 'more code' },
      ],
    };
    const result = cpdStats(report, 1000);
    assert.equal(result.clones, 2);
    assert.equal(result.duplicatedLines, 25); // 10*2 + 5*1
    assert.equal(result.percentage, 2.5); // 25/1000 * 100
  });

  it('returns 0 percentage when totalLines is 0', () => {
    const report = {
      duplicates: [{ lines: 10, files: [{ name: 'a.js' }], fragment: 'code' }],
    };
    const result = cpdStats(report, 0);
    assert.equal(result.percentage, 0);
  });
});

// ── cpdNewClones ─────────────────────────────────────────────────────

describe('cpdNewClones', () => {
  it('returns all duplicates when no base report', () => {
    const pr = { duplicates: [{ fragment: 'a' }, { fragment: 'b' }] };
    assert.equal(cpdNewClones(pr, null).length, 2);
  });

  it('filters out clones that existed in base', () => {
    const pr = { duplicates: [{ fragment: 'old' }, { fragment: 'new' }] };
    const base = { duplicates: [{ fragment: 'old' }] };
    const result = cpdNewClones(pr, base);
    assert.equal(result.length, 1);
    assert.equal(result[0].fragment, 'new');
  });

  it('returns empty when all clones existed in base', () => {
    const pr = { duplicates: [{ fragment: 'old' }] };
    const base = { duplicates: [{ fragment: 'old' }] };
    assert.equal(cpdNewClones(pr, base).length, 0);
  });
});

// ── jscpdNewClones ───────────────────────────────────────────────────

describe('jscpdNewClones', () => {
  it('returns all duplicates when no base report', () => {
    const pr = { duplicates: [{ fragment: 'a' }] };
    assert.equal(jscpdNewClones(pr, null).length, 1);
  });

  it('returns all when base has no duplicates field', () => {
    const pr = { duplicates: [{ fragment: 'a' }] };
    assert.equal(jscpdNewClones(pr, {}).length, 1);
  });

  it('filters out existing clones', () => {
    const pr = { duplicates: [{ fragment: 'old' }, { fragment: 'new' }] };
    const base = { duplicates: [{ fragment: 'old' }] };
    const result = jscpdNewClones(pr, base);
    assert.equal(result.length, 1);
    assert.equal(result[0].fragment, 'new');
  });
});

// ── checkFail ────────────────────────────────────────────────────────

describe('checkFail', () => {
  const thresholds = { maxPct: 5, maxIncrease: 0.1 };

  it('returns no fail for null stats', () => {
    const result = checkFail(null, null, thresholds);
    assert.equal(result.shouldFail, false);
  });

  it('passes when under thresholds', () => {
    const stats = { percentage: 3 };
    const base = { percentage: 2.95 };
    const result = checkFail(stats, base, thresholds);
    assert.equal(result.shouldFail, false);
    assert.equal(result.pctFail, false);
    assert.equal(result.increaseFail, false);
  });

  it('fails on absolute threshold', () => {
    const stats = { percentage: 6 };
    const base = { percentage: 5.95 };
    const result = checkFail(stats, base, thresholds);
    assert.equal(result.pctFail, true);
    assert.equal(result.shouldFail, true);
  });

  it('fails on increase threshold', () => {
    const stats = { percentage: 4 };
    const base = { percentage: 3.5 };
    const result = checkFail(stats, base, thresholds);
    assert.equal(result.increaseFail, true);
    assert.equal(result.shouldFail, true);
  });

  it('does not fail on increase when no base', () => {
    const stats = { percentage: 4 };
    const result = checkFail(stats, null, thresholds);
    assert.ok(!result.increaseFail); // null is falsy, not strictly false
    assert.equal(result.pctDelta, 0);
  });
});

// ── readConfig ───────────────────────────────────────────────────────

describe('readConfig', () => {
  const envBackup = {};

  before(() => {
    const keys = [
      'INPUT_DIRECTORIES', 'INPUT_FILE_EXTENSIONS', 'INPUT_CPD_MAX_PCT',
      'INPUT_CPD_MAX_INCREASE', 'INPUT_JSCPD_MAX_PCT', 'INPUT_JSCPD_MAX_INCREASE',
      'GITHUB_WORKSPACE',
    ];
    for (const key of keys) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  });

  after(() => {
    for (const [key, val] of Object.entries(envBackup)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('returns defaults when env is empty', () => {
    const config = readConfig();
    assert.deepEqual(config.directories, ['.']);
    assert.deepEqual(config.fileExtensions, []);
    assert.equal(config.thresholds.cpd.maxPct, 5);
    assert.equal(config.thresholds.cpd.maxIncrease, 0.1);
    assert.equal(config.thresholds.jscpd.maxPct, 4);
    assert.equal(config.thresholds.jscpd.maxIncrease, 0.1);
  });

  it('parses directories from env', () => {
    process.env.INPUT_DIRECTORIES = 'src test lib';
    const config = readConfig();
    assert.deepEqual(config.directories, ['src', 'test', 'lib']);
    delete process.env.INPUT_DIRECTORIES;
  });

  it('parses file extensions from env', () => {
    process.env.INPUT_FILE_EXTENSIONS = 'js, ts, tsx';
    const config = readConfig();
    assert.deepEqual(config.fileExtensions, ['js', 'ts', 'tsx']);
    delete process.env.INPUT_FILE_EXTENSIONS;
  });

  it('handles non-numeric threshold values', () => {
    process.env.INPUT_CPD_MAX_PCT = 'not-a-number';
    const config = readConfig();
    assert.equal(config.thresholds.cpd.maxPct, 5); // falls back to default
    delete process.env.INPUT_CPD_MAX_PCT;
  });
});

// ── parseCpdXml ──────────────────────────────────────────────────────

describe('parseCpdXml', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpd-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns null for non-existent file', async () => {
    assert.equal(await parseCpdXml('/no/such/file.xml'), null);
  });

  it('returns null for empty file', async () => {
    const f = path.join(tmpDir, 'empty.xml');
    fs.writeFileSync(f, '');
    assert.equal(await parseCpdXml(f), null);
  });

  it('parses valid CPD XML with duplications', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<pmd-cpd>
  <duplication lines="10" tokens="50">
    <file path="/src/a.js" line="1" endline="10"/>
    <file path="/src/b.js" line="20" endline="30"/>
    <codefragment>function hello() {}</codefragment>
  </duplication>
</pmd-cpd>`;
    const f = path.join(tmpDir, 'valid.xml');
    fs.writeFileSync(f, xml);
    const result = await parseCpdXml(f);
    assert.equal(result.duplicates.length, 1);
    assert.equal(result.duplicates[0].lines, 10);
    assert.equal(result.duplicates[0].tokens, 50);
    assert.equal(result.duplicates[0].files.length, 2);
    assert.equal(result.duplicates[0].files[0].name, '/src/a.js');
    assert.equal(result.duplicates[0].files[0].startLine, 1);
    assert.equal(result.duplicates[0].fragment, 'function hello() {}');
  });

  it('handles CPD XML with no duplications', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<pmd-cpd></pmd-cpd>`;
    const f = path.join(tmpDir, 'no-dupes.xml');
    fs.writeFileSync(f, xml);
    const result = await parseCpdXml(f);
    assert.deepEqual(result, { duplicates: [] });
  });

  it('returns null for malformed XML', async () => {
    const f = path.join(tmpDir, 'bad.xml');
    fs.writeFileSync(f, '<not valid xml<>');
    assert.equal(await parseCpdXml(f), null);
  });
});

// ── loadJscpd ────────────────────────────────────────────────────────

describe('loadJscpd', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jscpd-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns null for non-existent file', () => {
    assert.equal(loadJscpd('/no/such/file.json'), null);
  });

  it('returns null for invalid JSON', () => {
    const f = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(f, 'not json');
    assert.equal(loadJscpd(f), null);
  });

  it('parses valid JSON', () => {
    const data = { statistics: { total: { clones: 1 } } };
    const f = path.join(tmpDir, 'valid.json');
    fs.writeFileSync(f, JSON.stringify(data));
    assert.deepEqual(loadJscpd(f), data);
  });
});

// ── countTotalLines ──────────────────────────────────────────────────

describe('countTotalLines', () => {
  it('returns 0 for empty extensions list', () => {
    assert.equal(countTotalLines(['.'], []), 0);
  });

  it('returns 0 for non-existent directory', () => {
    assert.equal(countTotalLines(['/no/such/dir'], ['js']), 0);
  });

  it('counts lines in current directory for js files', () => {
    const lines = countTotalLines(['.'], ['js']);
    assert.ok(lines > 0, `Expected positive line count, got ${lines}`);
  });
});

// ── renderEngineSection ──────────────────────────────────────────────

describe('renderEngineSection', () => {
  it('renders passing section with no new clones', () => {
    const prStats = { clones: 2, duplicatedLines: 20, percentage: 1.5 };
    const baseStats = { clones: 2, duplicatedLines: 20, percentage: 1.5 };
    const check = { shouldFail: false, pctFail: false, increaseFail: false, pctDelta: 0 };
    const thresholds = { maxPct: 5, maxIncrease: 0.1 };
    const md = renderEngineSection('Test Engine', prStats, baseStats, [], () => '', check, thresholds);
    assert.ok(md.includes(':white_check_mark: Test Engine'));
    assert.ok(md.includes('No new clones introduced'));
  });

  it('renders failing section with new clones', () => {
    const prStats = { clones: 3, duplicatedLines: 30, percentage: 6 };
    const baseStats = { clones: 2, duplicatedLines: 20, percentage: 4 };
    const clones = [{ id: 1 }];
    const check = { shouldFail: true, pctFail: true, increaseFail: true, pctDelta: 2 };
    const thresholds = { maxPct: 5, maxIncrease: 0.1 };
    const formatClone = () => '- clone\n';
    const md = renderEngineSection('Test Engine', prStats, baseStats, clones, formatClone, check, thresholds);
    assert.ok(md.includes(':x: Test Engine'));
    assert.ok(md.includes(':x: FAIL'));
    assert.ok(md.includes('1 new clones introduced'));
  });

  it('renders without base stats', () => {
    const prStats = { clones: 1, duplicatedLines: 10, percentage: 1 };
    const check = { shouldFail: false, pctFail: false, increaseFail: false, pctDelta: 0 };
    const thresholds = { maxPct: 5, maxIncrease: 0.1 };
    const md = renderEngineSection('Test Engine', prStats, null, [], () => '', check, thresholds);
    assert.ok(md.includes('no base'));
  });
});
