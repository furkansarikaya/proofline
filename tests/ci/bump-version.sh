#!/bin/sh
# Release version bump (A168): rewrites ONLY the version-holding sites listed in CONTRIBUTING.md, each by an anchored
# pattern, never a global replace (a global replace rewrote history comments in 0.0.25).
# Usage: sh tests/ci/bump-version.sh <new-version>   bump every site, move CHANGELOG Unreleased, run the generators
#        sh tests/ci/bump-version.sh --check         fail when a site disagrees with .claude-plugin/plugin.json
# BUMP_DATE=YYYY-MM-DD overrides today's date in the CHANGELOG heading.
# shellcheck disable=SC2016
set -eu
root=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
cd "$root"
SEMVER='[0-9]+\.[0-9]+\.[0-9]+'
die() { printf 'bump-version: %s\n' "$*" >&2; exit 1; }
usage() { die "usage: bump-version.sh <new-version> | --check"; }
cur=$(sed -n 's/^  "version": "\([0-9][0-9.]*\)",$/\1/p' .claude-plugin/plugin.json | head -n 1)
printf '%s' "$cur" | grep -Eq "^$SEMVER\$" || die "cannot read the current version from .claude-plugin/plugin.json"

[ $# -eq 1 ] || usage
mode=probe
new=$cur
if [ "$1" = --check ]; then
  mode=check
else
  new=$1
  printf '%s' "$new" | grep -Eq "^$SEMVER\$" || die "invalid version '$new' (want MAJOR.MINOR.PATCH)"
  [ "$new" != "$cur" ] || die "new version equals the current version $cur"
fi

# a version with its dots escaped for a regex; _js for a regex literal inside a JavaScript test (0\.0\.25 in the file)
re() { printf '%s' "$1" | sed 's/\./\\./g'; }
re_js() { printf '%s' "$1" | sed 's/\./\\\\\\./g'; }
repl_js() { printf '%s' "$1" | sed 's/\./\\\\./g'; }

bad=0
# site FILE PRE POST JS ADDR: the version sits between the anchored PRE and POST (ERE, no groups). JS=1 when the file
# spells it as a regex literal. ADDR is an optional sed address that confines the rewrite (SKILL.md frontmatter).
# probe: the current version must be there; check: no other version may be there; bump: rewrite it.
site() {
  f=$1 pre=$2 post=$3 js=$4 addr=${5:-}
  [ -f "$f" ] || die "missing site file $f"
  if [ "$js" = 1 ]; then anyv='[0-9]+\\\.[0-9]+\\\.[0-9]+'; oldv=$(re_js "$cur"); newv=$(repl_js "$new")
  else anyv=$SEMVER; oldv=$(re "$cur"); newv=$new; fi
  case $mode in
    probe) grep -Eq "$pre$oldv$post" "$f" || die "site not found in $f: $pre" ;;
    check)
      if grep -Eq "$pre$anyv$post" "$f"; then
        grep -Eq "$pre$oldv$post" "$f" || { printf 'mismatch: %s (%s) is not %s\n' "$f" "$pre" "$cur"; bad=1; }
      else printf 'missing: %s (%s)\n' "$f" "$pre"; bad=1; fi ;;
    bump)
      tmp=$(mktemp)
      sed -E "${addr}s~($pre)$oldv($post)~\\1$newv\\2~" "$f" > "$tmp"
      cat "$tmp" > "$f"; rm -f "$tmp" ;;
  esac
}

sites() {
  site bin/proofline '^PROOFLINE_VERSION=' '$' 0
  site .claude-plugin/plugin.json '^  "version": "' '",$' 0
  site .claude-plugin/marketplace.json '^ *"version": "' '"$' 0
  site control-plane/agents/config.yaml '^proofline_version: ' '$' 0
  site playground/package.json '^  "version": "' '",?$' 0
  for f in skills/*/SKILL.md; do site "$f" '^  version: "' '"$' 0 '1,/^---$/'; done
  site skills/exploit-proof/scripts/diff-manifests.mjs '^export const SKILL_VERSION = "' '";$' 0
  site skills/proof-review/scripts/check-config.mjs '^export const SKILL_VERSION = "' '";$' 0
  site skills/proof-review/references/REPORTING.md '^  "skill_version": "' '",$' 0
  site README.md '^Version ' ' is an early release\.$' 0
  site README.md '^Version \*\*' '\*\*: full scope' 0
  site adapters/README.md '^## Support status \(' '\)$' 0
  site fixtures/concurrency-proof/selfcheck.sh 'skill_version: "' '"' 0
  site fixtures/insights/setup.sh 'proofline_version: ' '\\nmetrics' 0
  site tests/cli/cli-test.sh 'expect "version prints proofline ' '" "\$out"' 0
  site tests/cli/cli-test.sh '" "\$out" "proofline ' '"$' 0
  site tests/cli/cli-test.sh '\.claude-plugin/plugin\.json"\)" = ' ' \] && ok "plugin\.json version' 0
  site tests/cli/cli-test.sh 'proofline_version\)" = ' ' \] && ok "config: proofline_version stamped' 0
  site tests/cli/cli-test.sh "grep -q '\\^# version: " "'" 0
  site tests/cli/cli-test.sh 'version\)" = "proofline ' '" \] && ok "install\.sh' 0
  site tests/skills/concurrency-proof.test.mjs 'schema_version: 1, skill_version: "' '"' 0
  site tests/skills/proof-review.test.mjs 'schema_version: 1, skill_version: "' '"' 0
  site tests/skills/data-design.test.mjs '\\n  version: "' '"\\n---' 1
  site tests/skills/proofline-lead.test.mjs '\^ \{2\}version: "' '"\$/m' 1
}

if [ "$mode" = check ]; then
  sites
  [ "$bad" = 0 ] || die "version sites disagree with plugin.json ($cur)"
  printf 'bump-version: every version site is %s\n' "$cur"
  exit 0
fi

# CHANGELOG: the Unreleased section must have entries to move
awk '/^## Unreleased$/ {u=1; next} u && /^## / {exit} u && NF {n++} END {exit n ? 0 : 1}' CHANGELOG.md \
  || die "CHANGELOG.md has no Unreleased entries to move"
sites
mode=bump
sites
date=${BUMP_DATE:-$(date +%Y-%m-%d)}
tmp=$(mktemp)
awk -v v="$new" -v d="$date" '{print} /^## Unreleased$/ {print ""; printf "## %s — %s\n", v, d}' CHANGELOG.md > "$tmp"
cat "$tmp" > CHANGELOG.md; rm -f "$tmp"
sh adapters/generate.sh >/dev/null
sh docs/reference/generate-skills.sh >/dev/null
printf 'bump-version: %s -> %s\n' "$cur" "$new"
