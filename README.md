# Duplicate Code Cross-Check

A GitHub Action that detects duplicate code on pull requests using **two complementary engines** and posts a single unified PR comment with base-vs-PR comparison.

## Why we built this

Agentic programming makes duplicate code a much bigger problem. LLM-based agents tend to copy patterns they've already seen in the codebase rather than refactor to reuse them, and without a hard gate, duplication quietly accumulates. We wanted a simple CI check that:

1. Runs on every PR automatically
2. Fails the build if a PR increases duplication (not just if it exceeds some absolute ceiling)
3. Posts a clear comparison comment so the author can see exactly what changed
4. Points at specific lines of new duplication in the PR diff

After surveying the GitHub Marketplace, no existing action does all four. So we built this.

## How it's different from other tools

### [platisd/duplicate-code-detection-tool](https://github.com/platisd/duplicate-code-detection-tool) — complementary, different approach

This is the most prominent existing tool (~205 stars). It uses **gensim TF-IDF cosine similarity** to produce a *whole-file similarity score* — it tells you "these two files are 45% similar" but doesn't point at specific duplicated blocks. It's great for catching files that should be merged or refactored at an architectural level.

Our action is the inverse: **we find specific copy-pasted blocks** with line numbers, using token-based detectors (PMD CPD + jscpd). We tell you "lines 50-65 here are duplicated with lines 120-135 over there."

**The two tools are complementary, not competing.** We recommend running both:

- Use `platisd/duplicate-code-detection-tool` to spot files that are semantically similar overall
- Use this action to spot exact copy-paste blocks that should be refactored into shared helpers

We've also submitted a PR upstream to add base-vs-PR comparison to their tool so it can catch regressions the way this action does.

### Stacked PR detection tools (jscpd-action, pmd-github-action, etc.)

A handful of marketplace actions wrap jscpd or PMD CPD, but none of them compare the PR against its base branch — they just report total duplication in the PR. That means you can't tell if a PR *introduced* duplication or just inherited it. This action is the only one we found that does the delta comparison, which is what you actually want to gate merges on.

## Why two engines?

| Engine | Strength |
|--------|----------|
| **PMD CPD** | Deep language awareness for Java, Kotlin, C++, Python, Go, Ruby, Scala, JavaScript, and more. Fewer false positives from imports, annotations, literals. |
| **jscpd** | Language-agnostic token matching. Catches duplication that PMD CPD may miss, and works on languages PMD doesn't support. |

Running both gives cross-validation. If both flag the same block, it's almost certainly real duplication. If only one flags it, the signal is weaker but still worth a look.

## What you get on every PR

- **A single PR comment** with a section per engine showing:
  - Clones / duplicated lines / duplication percentage
  - Delta vs the base branch (with emoji reactions based on magnitude)
  - Pass / fail status against your configured thresholds
  - Collapsible list of new clones introduced by this PR
- **Inline PR review comments** on the diff, pointing at specific lines of new duplication
- **CI failure** if any engine's duplication exceeds the ceiling or increases vs base

## Usage

### Minimal

No language configuration needed - the action auto-detects from your source files:

```yaml
name: PR Checks
on: pull_request

jobs:
  duplicate-code:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: astubbs/duplicate-code-cross-check@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          directories: src
```

### Full configuration (overrides auto-detection)

```yaml
      - uses: astubbs/duplicate-code-cross-check@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          directories: 'src/main src/test'
          file-extensions: 'java,kt'
          cpd-language: 'java'
          cpd-min-tokens: '70'
          cpd-max-duplication: '5'
          cpd-max-increase: '0.1'
          jscpd-file-pattern: '**/*.{java,kt}'
          jscpd-ignore-pattern: '**/target/**,**/build/**,**/node_modules/**'
          jscpd-min-lines: '6'
          jscpd-min-tokens: '70'
          jscpd-max-duplication: '4'
          jscpd-max-increase: '0.1'
          pmd-version: '7.9.0'
```

## Language auto-detection

By default, all three language-sensitive inputs (`cpd-language`, `jscpd-file-pattern`, `file-extensions`) are set to `auto`. The action scans your configured directories, counts files by extension, and:

- **CPD language** - picks the dominant language (the one with the most source files). File counts are aggregated per language, so `.ts` + `.tsx` files both count toward `typescript`. If no CPD-supported language is found (e.g., a pure Astro project), CPD is skipped and only jscpd runs.
- **jscpd file pattern** - includes all detected source extensions, not just the dominant one, since jscpd is language-agnostic.
- **file-extensions** - includes all detected extensions for accurate line-count percentage calculation.

Each input is resolved independently. You can override one while leaving the others on `auto` - for example, set `cpd-language: python` explicitly while letting jscpd pattern auto-detect.

## Inputs

| Input | Required | Default | Purpose |
|-------|----------|---------|---------|
| `github-token` | yes | - | Token for posting PR comments and review annotations |
| `directories` | yes | - | Space-separated directories to scan |
| `file-extensions` | no | `auto` | Extensions (comma-separated) for line-count percentage, or `auto` to detect |
| `cpd-language` | no | `auto` | PMD CPD language (see [PMD docs](https://pmd.github.io/pmd/pmd_userdocs_cpd.html)), or `auto` to detect |
| `cpd-min-tokens` | no | `70` | Minimum tokens before PMD CPD flags a clone |
| `cpd-max-duplication` | no | `5` | PMD CPD fails if total duplication exceeds this % |
| `cpd-max-increase` | no | `0.1` | PMD CPD fails if duplication grows by more than this % vs base |
| `jscpd-file-pattern` | no | `auto` | jscpd glob for files to scan, or `auto` to detect |
| `jscpd-ignore-pattern` | no | `**/target/**,**/node_modules/**,**/build/**,**/dist/**,**/__pycache__/**,**/vendor/**,**/.venv/**,**/.next/**,**/.output/**,**/.nuxt/**,**/*.egg-info/**,**/out/**,**/.git/**` | jscpd comma-separated ignore patterns |
| `jscpd-min-lines` | no | `6` | Minimum lines before jscpd flags a clone |
| `jscpd-min-tokens` | no | `70` | Minimum tokens before jscpd flags a clone |
| `jscpd-max-duplication` | no | `4` | jscpd fails if total duplication exceeds this % |
| `jscpd-max-increase` | no | `0.1` | jscpd fails if duplication grows by more than this % vs base |
| `pmd-version` | no | `7.9.0` | PMD version to install |

## Permissions

The action needs:

```yaml
permissions:
  contents: read
  pull-requests: write
```

`checkout` must use `fetch-depth: 0` so the action can check out the base branch for comparison.

## How fail conditions work

Each engine has two independent thresholds:

- **`max-duplication`** (absolute ceiling) — fails if total duplication exceeds this percentage. Tune this just above your current baseline to prevent the ratio from ever getting worse while still passing today.
- **`max-increase`** (relative vs base) — fails if duplication grows by more than this percentage between base and PR. This is the real safety net: it catches regressions regardless of the absolute baseline, and you don't have to keep retuning it as the codebase changes.

Clones are identified by a hash of their content (not file:line), so refactors that shift line numbers don't create false positives for "new clones."

## License

Apache-2.0
