#!/usr/bin/env bash
#
# Enumerate the source-file extensions present under one or more directories, most common first,
# as `<count> <extension>` lines on stdout. Rejected suffixes are listed on stderr, so a file the
# scan declines to classify is visible rather than silently dropped.
#
# WHY THIS IS NOT A ONE-LINE `sed`. The pipeline this replaces was:
#
#   find $DIRS -type f ... | grep '\.' | sed 's/.*\.//' | sort | uniq -c | sort -rn
#
# `grep '\.'` keeps any path containing a dot ANYWHERE, and `sed 's/.*\.//'` then cuts at the last
# dot in the WHOLE PATH rather than in the file name. Every path whose only dot sits in a directory
# component - or is the leading `./` - therefore yields a fragment that is not an extension at all.
# Measured on parallel-consumer, the old pipeline emitted these alongside the real extensions:
#
#   /mvnw  /LICENSE  /NOTICE  github/CODEOWNERS  githooks/pre-commit  0/bin/pmd  0/LICENSE
#   config  editorconfig  gitignore  gitmessage  TestExecutionListener
#
# They became members of the jscpd brace glob `**/*.{...}` and of the extension list report.js uses
# as its line-count denominator. The `0/...` entries are the giveaway: they are `pmd-bin-7.9.0/`
# cut after the patch number, i.e. the action's own PMD download, which used to be unzipped into
# the workspace it then scanned.
#
# So an extension here is the suffix of the FILE NAME after its last dot, and only when the name has
# a dot that is not its first character - `.gitignore` is a dot-file, not a `gitignore` file.
#
# Archive, image, font and compiled-binary extensions are dropped. jscpd cannot tokenise them, and
# report.js counts newline BYTES in every file matching the extension list, so one checked-in jar
# contributes hundreds of thousands of phantom "lines" to the denominator every duplication
# percentage is divided by. Measured: PMD's own distribution inflated it 4.01x (793,019 vs 197,832
# lines on parallel-consumer), which is a duplication reading four times smaller than the truth.
#
# Usage: bin/detect-extensions.sh <dir> [<dir>...]

set -euo pipefail

if [[ $# -eq 0 ]]; then
    echo "usage: $(basename "$0") <dir> [<dir>...]" >&2
    exit 2
fi

# Extensions that are never source text.
NON_SOURCE_EXTENSIONS='
jar war ear aar zip tar gz tgz bz2 xz 7z rar lzma zst
class so dll dylib exe bin obj o lib pyc pyo pyd wasm
png jpg jpeg gif bmp ico webp tiff tif psd eps icns
pdf doc docx xls xlsx ppt pptx odt ods odp rtf
woff woff2 ttf otf eot
mp3 mp4 m4a avi mov wav ogg oga ogv webm flac mkv
jks p12 pfx keystore der crt cer pack idx db sqlite sqlite3 dat
'

# The longest extension in real use is around ten characters (`properties`, `sqlite3`). Beyond that
# a "suffix" is a dotted file name: `org.junit.platform.launcher.TestExecutionListener` is a service
# registration file, not a `.TestExecutionListener` file.
MAX_EXTENSION_LENGTH=10

# `find` exits non-zero when it meets an unreadable directory, which under `pipefail` would fail
# the whole scan over one stray permission bit; the old pipeline swallowed that and so does this.
# The denylist is flattened to one line because BSD awk rejects a newline inside a `-v` value - the
# runner is Linux, but this script has to be runnable by hand on a Mac to be debuggable.
{ find "$@" -type f \
    -not -path '*/.git/*' \
    -not -path '*/node_modules/*' \
    -not -path '*/vendor/*' \
    -not -path '*/__pycache__/*' \
    -not -path '*/.venv/*' \
    2>/dev/null || true; } \
| awk -v denylist="$(printf '%s' "$NON_SOURCE_EXTENSIONS" | tr '\n' ' ')" \
      -v maxlen="$MAX_EXTENSION_LENGTH" '
BEGIN {
    split(denylist, denied, /[ \t\n]+/)
    for (i in denied) if (denied[i] != "") deny[denied[i]] = 1
}
{
    segments = split($0, segment, "/")
    name = segment[segments]

    parts = split(name, part, ".")
    if (parts < 2) next                          # no dot at all: mvnw, CODEOWNERS, pre-commit
    if (part[1] == "" && parts == 2) next        # dot-file with no extension: .gitignore
    ext = part[parts]
    if (ext == "") next                          # trailing dot: "foo."
    if (length(ext) > maxlen) next               # a dotted file name, not an extension
    if (ext !~ /^[A-Za-z0-9_+-]+$/) next

    lower = tolower(ext)
    if (lower in deny) { rejected[lower] = 1; next }
    count[ext]++
}
END {
    for (ext in count) print count[ext], ext

    n = 0
    for (ext in rejected) { n++; list = (list == "" ? ext : list " " ext) }
    if (n > 0) print "Ignored non-source extensions: " list > "/dev/stderr"
}
' | sort -k1,1nr -k2,2
