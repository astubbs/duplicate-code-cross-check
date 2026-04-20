---
title: "fix: Auto-detect language instead of defaulting to Java"
type: fix
status: active
date: 2026-04-20
deepened: 2026-04-20
---

# fix: Auto-detect language instead of defaulting to Java

## Overview

The action's three language-sensitive inputs (`cpd-language`, `jscpd-file-pattern`, `file-extensions`) all default to Java. Users scanning non-Java projects must override all three, and the minimal usage example silently scans nothing useful if the project has no `.java` files. This fix adds an auto-detection step that infers the right values from the files actually present in the scanned directories.

## Problem Frame

The action was built for a Java project and shipped with Java defaults. Now that it's used across language ecosystems (JavaScript/TypeScript, Astro, Python, etc.), the Java defaults are a footgun: the minimal config produces empty or misleading results for non-Java repos. The "Full configuration" example in the README shows the workaround, but the action should just work out of the box for any supported language.

## Requirements Trace

- R1. When no language inputs are explicitly set, the action auto-detects the dominant language from files in the scanned directories
- R2. Explicit user overrides for any of the three inputs still take precedence over auto-detection, on a per-input basis
- R3. jscpd file pattern includes all detected extensions (not just the dominant one), since jscpd is language-agnostic
- R4. When no supported CPD language is found (e.g., pure `.astro` project), CPD is skipped gracefully with a warning
- R5. The self-test workflow continues to pass
- R6. README documents the auto-detection behavior and updated defaults
- R7. Default ignore patterns cover common build/dependency directories across ecosystems (not just Java's `target/`)

## Scope Boundaries

- Multi-language CPD (running CPD once per detected language and merging XML) is out of scope - CPD uses the single dominant language
- No new npm dependencies

### Deferred to Separate Tasks

- Multi-language CPD support (run CPD N times, merge results): future iteration if users request it

## Context & Research

### Relevant Code and Patterns

- `action.yml:18-38` - the three defaulted inputs with Java defaults
- `action.yml:39-42` - `jscpd-ignore-pattern` default includes Java-specific `**/target/**`
- `action.yml:85-97` - where CPD and jscpd are invoked; both engines run in combined `run:` blocks with `|| true` for graceful failure
- `action.yml:104-118` - report step uses `env:` block with `${{ inputs.file-extensions }}` (template-expanded at parse time, not runtime)
- `.github/workflows/self-test.yml` - explicitly sets all three language inputs
- `report.js:35` - `fileExtensions` fallback hardcodes `'java'`
- `report.js:57-65` - `countTotalLines` uses `find ${dirs.join(' ')}` pattern for directory scanning
- `report.js:230` - hardcoded section title `'PMD CPD (Java-aware)'`

### External References

- PMD CPD supported languages: java, javascript, typescript, python, kotlin, cpp, csharp, go, ruby, scala, swift, lua, matlab, objectivec, plsql, xml, and more
- jscpd is language-agnostic and works with any glob pattern

## Key Technical Decisions

- **Auto-detect via file counting, not heuristics**: Count files by extension in the scanned directories, map extensions to CPD languages, pick the one with the most files. Simple, deterministic, no dependencies.
- **Sentinel default value `auto`**: Change the three input defaults to `auto`. When the action sees `auto`, it runs detection. Any explicit value bypasses detection for that specific input. This preserves full backward compatibility for users who already set these inputs.
- **Per-input resolution, not all-or-nothing**: Each of the three inputs is resolved independently. If a user sets `cpd-language: python` but leaves `jscpd-file-pattern` at `auto`, detection still runs to resolve the jscpd pattern. This is the most useful behavior for partial overrides.
- **Use `$GITHUB_ENV` for value threading**: Resolved values are written to `$GITHUB_ENV` (not `$GITHUB_OUTPUT`) so they are available as environment variables in all subsequent steps, including the `env:` block of the `actions/github-script` report step. This avoids the parse-time vs runtime mismatch that `${{ inputs.X }}` + `${{ steps.X.outputs.Y }}` would create.
- **Extension-to-CPD-language mapping in shell**: A simple bash case statement. File counts are aggregated per CPD language (e.g., `.ts` + `.tsx` both count toward `typescript`), not per individual extension.
- **jscpd gets all extensions**: Since jscpd is language-agnostic, its pattern should include all source file extensions found, not just the dominant language's.
- **CPD skip via bash conditional, not step-level `if:`**: The "Run both engines" steps combine CPD and jscpd in a single `run:` block that also handles `git checkout`. A step-level `if:` skip would also skip jscpd on the base branch, breaking the comparison. Instead, wrap CPD invocations in `if [[ "$SKIP_CPD" != "true" ]]` inside the existing bash blocks.
- **Existing `|| true` already handles CPD failure gracefully**: PMD CPD exits non-zero when it can't parse files, and the `|| true` swallows it. `report.js` already handles missing/empty XML as `null` and renders "No report available". The skip flag adds an explicit early-exit path with a clear warning, but no new error handling infrastructure is needed.
- **Expand default ignore patterns**: Add common build/dependency directories across ecosystems to `jscpd-ignore-pattern` default: `__pycache__/`, `vendor/`, `.venv/`, `.next/`, `.output/`, `.nuxt/`, `*.egg-info/`, `out/`, `.git/`.
- **Fix report.js hardcodes**: Update `report.js:35` fallback from `'java'` to `''` (empty - surfaces broken config instead of silently defaulting). Update `report.js:230` section title from `'PMD CPD (Java-aware)'` to `'PMD CPD'`.

## Open Questions

### Resolved During Planning

- **Q: Should we support multiple CPD languages?** No - CPD only accepts one `--language` flag. Multi-language would require running CPD N times and merging XML, which is a separate feature. Pick the dominant language for now.
- **Q: What about TypeScript?** PMD CPD has a separate `typescript` language identifier (not `javascript`). The mapping must distinguish `.ts`/`.tsx` -> `typescript` from `.js`/`.mjs`/`.cjs`/`.jsx` -> `javascript`. If a project has both, the one with more files wins.
- **Q: What if file counts are tied?** Pick alphabetically among tied languages. Deterministic and simple.
- **Q: Per-input or all-or-nothing override?** Per-input. Each input is resolved independently: if its value is `auto`, the detected value is used; if it is anything else, the user's value is passed through unchanged.
- **Q: How do resolved values reach report.js?** Via `$GITHUB_ENV`. The detection step writes `RESOLVED_CPD_LANGUAGE=...`, `RESOLVED_JSCPD_PATTERN=...`, `RESOLVED_FILE_EXTENSIONS=...` to `$GITHUB_ENV`. The engine steps and report step's `env:` block reference these environment variables instead of `${{ inputs.X }}` directly.
- **Q: Step-level `if:` or bash conditional for CPD skip?** Bash conditional inside the existing combined `run:` blocks. A step-level skip would also skip jscpd base-branch data.
- **Q: Should we add a separate skip-cpd flag infrastructure?** No. The existing `|| true` + `report.js` null-check path already handles CPD failure. The detection step simply logs a warning and leaves the CPD language env var empty, which causes CPD to fail gracefully through the existing path. No new flag mechanism needed.

### Deferred to Implementation

- Exact extension-to-language mapping list: the implementer should consult PMD CPD docs for the full set of supported language identifiers and map common extensions
- Whether `find` needs `-not -path '*/.git/*'` guard (likely yes - include it)

## Implementation Units

- [ ] **Unit 1: Add auto-detect step and update value threading in action.yml**

  **Goal:** Replace Java defaults with `auto` sentinel, add a detection step that resolves actual values, and rewire all downstream steps to consume resolved values via `$GITHUB_ENV`.

  **Requirements:** R1, R2, R3, R4

  **Dependencies:** None

  **Files:**
  - Modify: `action.yml`

  **Approach:**
  - Change defaults for `cpd-language`, `jscpd-file-pattern`, and `file-extensions` to `auto`
  - Add a new composite step with `id: detect` (before "Run both engines on base branch") that:
    1. For each of the three inputs, checks if its value is `auto`
    2. If any input is `auto`, scans directories for file extensions using `find` with `-not -path '*/.git/*'` guard, following the same `find ${dirs}` pattern used in `report.js:57-65`
    3. Maps extensions to CPD language identifiers via a bash case statement, aggregating file counts per CPD language (e.g., `.ts` + `.tsx` both count toward `typescript`)
    4. Picks the dominant CPD language (highest aggregate file count; alphabetical tiebreak)
    5. Builds a jscpd glob from all detected source extensions (e.g., `**/*.{js,ts,tsx,astro}`)
    6. Builds a comma-separated file-extensions list from all detected extensions
    7. For each input: if it was `auto`, writes the resolved value to `$GITHUB_ENV`; if explicit, writes the user's value to `$GITHUB_ENV`
    8. If no CPD-mappable extensions are found, logs a warning and writes empty CPD language to `$GITHUB_ENV`
  - Rewrite "Run both engines on base branch" and "Run both engines on PR branch" steps to reference `$RESOLVED_CPD_LANGUAGE`, `$RESOLVED_JSCPD_PATTERN` env vars instead of `${{ inputs.cpd-language }}` / `${{ inputs.jscpd-file-pattern }}`
  - Wrap CPD invocations in `if [[ -n "$RESOLVED_CPD_LANGUAGE" ]]; then ... fi` (empty = skip)
  - Update "Generate combined duplicate report" step's `env:` block to use `${{ env.RESOLVED_FILE_EXTENSIONS }}` instead of `${{ inputs.file-extensions }}`

  **Patterns to follow:**
  - Existing composite step pattern in `action.yml` (shell: bash, run: |)
  - `$GITHUB_ENV` for cross-step environment variable propagation
  - `report.js:57-65` `find ${dirs.join(' ')}` pattern for directory scanning

  **Test scenarios:**
  - Happy path: directory with only `.js` files -> cpd-language=javascript, jscpd-file-pattern=\*\*/\*.js, file-extensions=js
  - Happy path: directory with `.ts` and `.js` files -> cpd-language picks the one with more files, jscpd-file-pattern includes both
  - Happy path: explicit `cpd-language: python` overrides auto-detect even in a JS repo, while jscpd-file-pattern still auto-detects
  - Happy path: all three inputs set explicitly -> detection step is a no-op, values pass through unchanged
  - Edge case: directory with `.astro` files only -> CPD language empty (skipped with warning), jscpd-file-pattern=\*\*/\*.astro
  - Edge case: empty directory -> both engines produce empty/no reports gracefully, action does not crash
  - Edge case: mixed `.ts`/`.tsx`/`.js` repo -> counts aggregated per CPD language (typescript vs javascript), dominant wins
  - Edge case: tie between two languages -> alphabetically first wins
  - Integration: `RESOLVED_FILE_EXTENSIONS` flows correctly to report.js, `countTotalLines` returns non-zero, percentage thresholds work

  **Verification:**
  - Resolved environment variables are correctly set in `$GITHUB_ENV`
  - Engine steps use resolved values, not raw `auto` string
  - Report step receives correct `INPUT_FILE_EXTENSIONS` value
  - CPD is skipped cleanly when no mappable language is found

- [ ] **Unit 2: Fix report.js Java hardcodes**

  **Goal:** Remove Java-specific hardcodes from report.js so it works correctly with any detected language.

  **Requirements:** R1, R4

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `report.js`

  **Approach:**
  - Change `report.js:35` fallback from `|| 'java'` to `|| ''` so a missing/broken `INPUT_FILE_EXTENSIONS` surfaces as an error (0 total lines, 0% duplication) rather than silently counting Java files
  - Change `report.js:230` section title from `'PMD CPD (Java-aware)'` to `'PMD CPD'`

  **Patterns to follow:**
  - Existing null-check patterns in report.js for missing engine data

  **Test scenarios:**
  - Happy path: `INPUT_FILE_EXTENSIONS=js,ts` -> `countTotalLines` counts `.js` and `.ts` files, percentages are correct
  - Edge case: `INPUT_FILE_EXTENSIONS` is empty string -> `countTotalLines` returns 0, percentages show 0% (visible signal, not silent wrong answer)
  - Happy path: report section title shows "PMD CPD" without language-specific qualifier

  **Verification:**
  - No remaining Java-specific strings in report.js
  - Percentage calculations work for non-Java extensions

- [ ] **Unit 3: Expand default ignore patterns**

  **Goal:** Update `jscpd-ignore-pattern` default to cover common build/dependency directories across ecosystems.

  **Requirements:** R7

  **Dependencies:** None (can be done in parallel with Unit 1)

  **Files:**
  - Modify: `action.yml`

  **Approach:**
  - Expand `jscpd-ignore-pattern` default from `'**/target/**,**/node_modules/**,**/build/**,**/dist/**'` to also include: `**/__pycache__/**,**/vendor/**,**/.venv/**,**/.next/**,**/.output/**,**/.nuxt/**,**/*.egg-info/**,**/out/**,**/.git/**`

  **Patterns to follow:**
  - Existing comma-separated glob format in the current default

  **Test scenarios:**
  - Happy path: jscpd does not scan files inside `node_modules/`, `__pycache__/`, `vendor/`, `.venv/`, `.next/`, etc.
  - Edge case: user overrides `jscpd-ignore-pattern` explicitly -> their value is used, not the expanded default

  **Verification:**
  - Default ignore list is comprehensive across Java, JS/TS, Python, Go, Ruby ecosystems

- [ ] **Unit 4: Update README and self-test**

  **Goal:** Document the auto-detection behavior and switch self-test to exercise the new default path.

  **Requirements:** R5, R6

  **Dependencies:** Unit 1, Unit 2, Unit 3

  **Files:**
  - Modify: `README.md`
  - Modify: `.github/workflows/self-test.yml`

  **Approach:**
  - Update the inputs table: change defaults from `java`/`**/*.java` to `auto` with description of auto-detection behavior
  - Update the `jscpd-ignore-pattern` default in the table to reflect expanded list
  - Update the "Minimal" usage example to note that no language config is needed
  - Add a brief "Language auto-detection" section explaining: file counting, per-CPD-language aggregation, per-input override behavior, what happens when no CPD language is found
  - Keep the "Full configuration" example but note it overrides auto-detection
  - Self-test: remove the explicit `cpd-language`, `jscpd-file-pattern`, and `file-extensions` inputs to exercise auto-detection (the repo contains `.js` files, so it should auto-detect `javascript`)

  **Patterns to follow:**
  - Existing README structure and table format

  **Test scenarios:**
  - Happy path: self-test passes with auto-detection on this JS-only repo
  - Happy path: README input table accurately reflects new defaults

  **Verification:**
  - README accurately describes the new behavior
  - Self-test workflow passes in CI without explicit language inputs

## System-Wide Impact

- **Interaction graph:** The auto-detect step writes to `$GITHUB_ENV`, which feeds into both engine steps and the report step's `env:` block. Report.js is otherwise unaffected (existing null-check paths handle CPD skip).
- **Error propagation:** If auto-detection fails (empty dirs, permission issues), the resolved values are empty strings. CPD is skipped (empty language), jscpd gets an empty pattern (finds nothing), and report.js renders both sections as "No report available". No crash path.
- **State lifecycle risks:** `$GITHUB_ENV` values persist for all subsequent steps in the job. If a future step is added that assumes `INPUT_FILE_EXTENSIONS` is always a valid extension list, the empty-string fallback could surprise it.
- **API surface parity:** The three language inputs now accept `auto` as a value in addition to their existing values. The `jscpd-ignore-pattern` default is expanded. No inputs are removed.
- **Unchanged invariants:** All threshold logic, delta comparison, PR comment posting, and inline annotations work exactly as before. Only the source of language/pattern values changes.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `find` traverses symlinks or `.git` directory | Add `-not -path '*/.git/*'` guard; action runs on ubuntu-latest CI only |
| Extension-to-language mapping misses an edge case | Start with common languages; users can still override with explicit values |
| Auto-detect picks wrong dominant language in mixed repos | Document behavior; explicit overrides always available; alphabetical tiebreak is deterministic |
| `$GITHUB_ENV` values collide with user-set env vars | Use `RESOLVED_` prefix to namespace; unlikely in practice |
| Expanded ignore patterns accidentally exclude user source files named `vendor/` etc. | Document the defaults clearly; user can override `jscpd-ignore-pattern` |

## Sources & References

- PMD CPD language list: https://pmd.github.io/pmd/pmd_userdocs_cpd.html
- Related code: `action.yml`, `report.js`, `.github/workflows/self-test.yml`
