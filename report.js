#!/usr/bin/env node
/**
 * Duplicate Code Cross-Check - report generation.
 *
 * Runs after PMD CPD and jscpd have been executed on both the base and PR
 * branches, parses their outputs, compares them, and posts a combined PR
 * comment with per-engine stats, delta, and fail/pass status.
 *
 * Expected input files (relative to cwd):
 *   cpd-pr.xml, cpd-base.xml                     - PMD CPD XML output
 *   jscpd-report/jscpd-report.json               - jscpd JSON (PR)
 *   jscpd-base/jscpd-report.json                 - jscpd JSON (base)
 *
 * Config via environment (set by action.yml):
 *   INPUT_DIRECTORIES         - space-separated directories scanned
 *   INPUT_CPD_MAX_PCT         - PMD CPD absolute threshold (%)
 *   INPUT_CPD_MAX_INCREASE    - PMD CPD increase-vs-base threshold (%)
 *   INPUT_JSCPD_MAX_PCT       - jscpd absolute threshold (%)
 *   INPUT_JSCPD_MAX_INCREASE  - jscpd increase-vs-base threshold (%)
 *   INPUT_FILE_EXTENSIONS     - extensions to count for percentage (e.g. "java,kt")
 *   GITHUB_WORKSPACE          - stripped from file paths in output
 */
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const path = require('path');

function readConfig() {
  const parseFloatOr = (v, fallback) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    directories: (process.env.INPUT_DIRECTORIES || '.').split(/\s+/).filter(Boolean),
    fileExtensions: (process.env.INPUT_FILE_EXTENSIONS || '').split(',').map(e => e.trim()).filter(Boolean),
    thresholds: {
      cpd:   { maxPct: parseFloatOr(process.env.INPUT_CPD_MAX_PCT, 5),    maxIncrease: parseFloatOr(process.env.INPUT_CPD_MAX_INCREASE, 0.1) },
      jscpd: { maxPct: parseFloatOr(process.env.INPUT_JSCPD_MAX_PCT, 4), maxIncrease: parseFloatOr(process.env.INPUT_JSCPD_MAX_INCREASE, 0.1) },
    },
    workspace: process.env.GITHUB_WORKSPACE || process.cwd(),
  };
}

// ── Shared helpers ────────────────────────────────────────────────────

function contentHash(fragment) {
  return crypto.createHash('md5').update(fragment || '').digest('hex');
}

function relPath(p, workspace) {
  if (!p) return p;
  const ws = workspace.endsWith('/') ? workspace : workspace + '/';
  if (p.startsWith(ws)) return p.slice(ws.length);
  return p;
}

function countTotalLines(dirs, extensions) {
  try {
    const extArgs = extensions.map(e => `-name '*.${e}'`).join(' -o ');
    const cmd = `find ${dirs.join(' ')} -type f \\( ${extArgs} \\) 2>/dev/null | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}'`;
    const result = execSync(cmd, { encoding: 'utf8', shell: '/bin/bash' });
    return parseInt(result.trim()) || 0;
  } catch {
    return 0;
  }
}

function deltaEmoji(d, isPercentage) {
  if (d === 0) return ':heavy_minus_sign:';
  if (d < 0) {
    const mag = Math.abs(d);
    if (isPercentage ? mag >= 1 : mag >= 20) return ':heart:';
    if (isPercentage ? mag >= 0.1 : mag >= 5) return ':thumbsup:';
    return ':slightly_smiling_face:';
  }
  const mag = d;
  if (isPercentage ? mag >= 1 : mag >= 20) return ':face_with_raised_eyebrow:';
  if (isPercentage ? mag >= 0.1 : mag >= 5) return ':face_with_monocle:';
  return ':face_with_diagonal_mouth:';
}

function fmtDelta(d, suffix) {
  const isPct = (suffix === '%');
  const emoji = deltaEmoji(d, isPct);
  if (d === 0) return `${emoji} 0`;
  const s = suffix || '';
  return d > 0 ? `${emoji} +${d}${s}` : `${emoji} ${d}${s}`;
}

// ── PMD CPD ───────────────────────────────────────────────────────────

async function parseCpdXml(filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) return null;
  const xml2js = require('xml2js');
  try {
    const result = await new xml2js.Parser().parseStringPromise(fs.readFileSync(filePath, 'utf8'));
    const root = result['pmd-cpd'];
    if (!root || !root.duplication) return { duplicates: [] };
    return {
      duplicates: root.duplication.map(d => ({
        lines: parseInt(d.$.lines),
        tokens: parseInt(d.$.tokens),
        files: (d.file || []).map(f => ({
          name: f.$.path,
          startLine: parseInt(f.$.line),
          endLine: parseInt(f.$.endline),
        })),
        fragment: (d.codefragment && d.codefragment[0]) || '',
      })),
    };
  } catch (err) {
    console.log(`Failed to parse ${filePath}: ${err.message}`);
    return null;
  }
}

function cpdStats(report, totalLines) {
  if (!report) return null;
  const clones = report.duplicates.length;
  const duplicatedLines = report.duplicates.reduce((sum, d) => sum + d.lines * d.files.length, 0);
  const percentage = totalLines > 0 ? (duplicatedLines / totalLines) * 100 : 0;
  return { clones, duplicatedLines, percentage };
}

function cpdNewClones(prReport, baseReport) {
  if (!baseReport) return prReport.duplicates || [];
  const baseHashes = new Set(baseReport.duplicates.map(d => contentHash(d.fragment)));
  return (prReport.duplicates || []).filter(d => !baseHashes.has(contentHash(d.fragment)));
}

// ── jscpd ─────────────────────────────────────────────────────────────

function loadJscpd(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function jscpdNewClones(prReport, baseReport) {
  if (!baseReport || !baseReport.duplicates) return prReport.duplicates || [];
  const baseHashes = new Set(baseReport.duplicates.map(d => contentHash(d.fragment)));
  return (prReport.duplicates || []).filter(d => !baseHashes.has(contentHash(d.fragment)));
}

// ── Report rendering ──────────────────────────────────────────────────

function renderEngineSection(title, prStats, baseStats, newClones, formatClone, check, thresholds) {
  const icon = check.shouldFail ? ':x:' : ':white_check_mark:';
  let md = `### ${icon} ${title}\n\n`;
  md += `| | PR | Base | Change |\n|---|--:|--:|--:|\n`;

  const cloneDelta = baseStats ? prStats.clones - baseStats.clones : 0;
  const linesDelta = baseStats ? prStats.duplicatedLines - baseStats.duplicatedLines : 0;

  md += `| **Clones** | ${prStats.clones} | ${baseStats ? baseStats.clones : '-'} | ${baseStats ? fmtDelta(cloneDelta) : '-'} |\n`;
  md += `| **Duplicated lines** | ${prStats.duplicatedLines} | ${baseStats ? baseStats.duplicatedLines : '-'} | ${baseStats ? fmtDelta(linesDelta) : '-'} |\n`;
  md += `| **Duplication** | ${prStats.percentage.toFixed(2)}% | ${baseStats ? baseStats.percentage.toFixed(2) + '%' : '-'} | ${baseStats ? fmtDelta(parseFloat(check.pctDelta.toFixed(2)), '%') : '-'} |\n\n`;

  md += `| Rule | Limit | Status |\n|------|-------|--------|\n`;
  md += `| Max duplication | ${thresholds.maxPct}% | ${check.pctFail ? ':x: FAIL' : ':white_check_mark: Pass'} (${prStats.percentage.toFixed(2)}%) |\n`;
  md += `| Max increase vs base | +${thresholds.maxIncrease}% | ${check.increaseFail ? ':x: FAIL' : ':white_check_mark: Pass'} (${baseStats ? (check.pctDelta >= 0 ? '+' : '') + check.pctDelta.toFixed(2) + '%' : 'no base'}) |\n\n`;

  if (newClones.length > 0) {
    md += `<details><summary>:warning: ${newClones.length} new clones introduced</summary>\n\n`;
    for (const clone of newClones.slice(0, 20)) {
      md += formatClone(clone);
    }
    if (newClones.length > 20) md += `\n...and ${newClones.length - 20} more\n`;
    md += `\n</details>\n\n`;
  } else if (baseStats) {
    md += `No new clones introduced by this PR.\n\n`;
  }

  return md;
}

function checkFail(stats, baseStats, thresholds) {
  if (!stats) return { shouldFail: false, pctFail: false, increaseFail: false, pctDelta: 0 };
  const pctDelta = baseStats ? stats.percentage - baseStats.percentage : 0;
  const pctFail = stats.percentage > thresholds.maxPct;
  const increaseFail = baseStats && pctDelta > thresholds.maxIncrease;
  return { shouldFail: pctFail || increaseFail, pctFail, increaseFail, pctDelta };
}

// ── Main entrypoint ───────────────────────────────────────────────────

async function analyzeAndReport({ github, context, core }) {
  const config = readConfig();
  const totalLines = countTotalLines(config.directories, config.fileExtensions);
  const makeRel = (p) => relPath(p, config.workspace);

  // PMD CPD
  const cpdPr = await parseCpdXml('cpd-pr.xml');
  const cpdBase = await parseCpdXml('cpd-base.xml');
  const cpdPrStats = cpdStats(cpdPr, totalLines);
  const cpdBaseStats = cpdStats(cpdBase, totalLines);
  const cpdNew = cpdPr ? cpdNewClones(cpdPr, cpdBase) : [];
  const cpdCheck = cpdPrStats ? checkFail(cpdPrStats, cpdBaseStats, config.thresholds.cpd) : { shouldFail: false };

  // jscpd
  const jscpdPr = loadJscpd('jscpd-report/jscpd-report.json');
  const jscpdBase = loadJscpd('jscpd-base/jscpd-report.json');
  const jscpdPrStats = jscpdPr ? {
    clones: jscpdPr.statistics.total.clones,
    duplicatedLines: jscpdPr.statistics.total.duplicatedLines,
    percentage: parseFloat(jscpdPr.statistics.total.percentage),
  } : null;
  const jscpdBaseStats = jscpdBase ? {
    clones: jscpdBase.statistics.total.clones,
    duplicatedLines: jscpdBase.statistics.total.duplicatedLines,
    percentage: parseFloat(jscpdBase.statistics.total.percentage),
  } : null;
  const jscpdNew = jscpdPr ? jscpdNewClones(jscpdPr, jscpdBase) : [];
  const jscpdCheck = jscpdPrStats ? checkFail(jscpdPrStats, jscpdBaseStats, config.thresholds.jscpd) : { shouldFail: false };

  const anyFail = cpdCheck.shouldFail || jscpdCheck.shouldFail;
  const overallIcon = anyFail ? ':x:' : ':white_check_mark:';

  let body = `## ${overallIcon} Duplicate Code Report\n\n`;
  body += `Two engines run in parallel for cross-validation. Each has its own thresholds tuned to its baseline - the real safety net is the per-engine "max increase vs base" check.\n\n`;

  if (cpdPrStats) {
    const formatClone = (d) => {
      const locations = d.files.map(f => `\`${makeRel(f.name)}:${f.startLine}\``).join(' <-> ');
      return `- **${d.lines} lines** (${d.tokens} tokens): ${locations}\n`;
    };
    body += renderEngineSection('PMD CPD', cpdPrStats, cpdBaseStats, cpdNew, formatClone, cpdCheck, config.thresholds.cpd);
  } else {
    body += `### :question: PMD CPD\n\nNo report available.\n\n`;
  }

  if (jscpdPrStats) {
    const formatClone = (d) => {
      const f1 = makeRel(d.firstFile.name);
      const f2 = makeRel(d.secondFile.name);
      return `- **${d.lines} lines**: \`${f1}:${d.firstFile.startLoc.line}\` <-> \`${f2}:${d.secondFile.startLoc.line}\`\n`;
    };
    body += renderEngineSection('jscpd (language-agnostic)', jscpdPrStats, jscpdBaseStats, jscpdNew, formatClone, jscpdCheck, config.thresholds.jscpd);
  } else {
    body += `### :question: jscpd\n\nNo report available.\n\n`;
  }

  body += `\n<sub>Powered by [astubbs/duplicate-code-cross-check](https://github.com/astubbs/duplicate-code-cross-check)</sub>\n`;

  // Post or update PR comment
  const comments = await github.rest.issues.listComments({
    owner: context.repo.owner, repo: context.repo.repo, issue_number: context.issue.number
  });
  const existing = comments.data.find(c => c.body.startsWith('## ') && c.body.includes('Duplicate Code Report'));
  if (existing) {
    await github.rest.issues.updateComment({
      owner: context.repo.owner, repo: context.repo.repo, comment_id: existing.id, body
    });
  } else {
    await github.rest.issues.createComment({
      owner: context.repo.owner, repo: context.repo.repo, issue_number: context.issue.number, body
    });
  }

  // Annotate new CPD clones on PR diff (CPD preferred for accuracy)
  const annotateClones = cpdNew.length > 0 ? cpdNew : [];
  if (annotateClones.length > 0) {
    const { data: files } = await github.rest.pulls.listFiles({
      owner: context.repo.owner, repo: context.repo.repo, pull_number: context.issue.number
    });
    const changedFiles = new Set(files.map(f => f.filename));
    for (const d of annotateClones.slice(0, 10)) {
      for (const file of d.files) {
        const relFile = makeRel(file.name);
        if (changedFiles.has(relFile)) {
          const others = d.files.filter(f => f !== file).map(f => `${makeRel(f.name)}:${f.startLine}`).join(', ');
          try {
            await github.rest.pulls.createReviewComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: context.issue.number,
              commit_id: context.sha,
              path: relFile,
              line: file.startLine,
              body: `:warning: **Duplicate code detected** - ${d.lines} lines duplicated with \`${others}\``
            });
          } catch (e) {
            console.log(`Could not annotate ${relFile}:${file.startLine} - ${e.message}`);
          }
          break;
        }
      }
    }
  }

  if (anyFail) {
    const msgs = [];
    if (cpdCheck.shouldFail) msgs.push('PMD CPD');
    if (jscpdCheck.shouldFail) msgs.push('jscpd');
    core.setFailed(`Duplicate code check failed (${msgs.join(', ')}) - see PR comment for details`);
  }
}

module.exports = { analyzeAndReport };
