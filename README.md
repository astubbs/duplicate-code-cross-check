# Duplicate Code Cross-Check

A GitHub Action that detects duplicate code on pull requests using **two complementary engines** and posts a single unified PR comment with base-vs-PR comparison.

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

### Full configuration

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

## Inputs

| Input | Required | Default | Purpose |
|-------|----------|---------|---------|
| `github-token` | yes | - | Token for posting PR comments and review annotations |
| `directories` | yes | - | Space-separated directories to scan |
| `file-extensions` | no | `java` | Extensions (comma-separated) used to count total lines for percentage |
| `cpd-language` | no | `java` | PMD CPD language (see [PMD docs](https://pmd.github.io/pmd/pmd_userdocs_cpd.html) for supported languages) |
| `cpd-min-tokens` | no | `70` | Minimum tokens before PMD CPD flags a clone |
| `cpd-max-duplication` | no | `5` | PMD CPD fails if total duplication exceeds this % |
| `cpd-max-increase` | no | `0.1` | PMD CPD fails if duplication grows by more than this % vs base |
| `jscpd-file-pattern` | no | `**/*.java` | jscpd glob for files to scan |
| `jscpd-ignore-pattern` | no | `**/target/**,**/node_modules/**,**/build/**,**/dist/**` | jscpd comma-separated ignore patterns |
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
