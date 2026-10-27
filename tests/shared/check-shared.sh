#!/bin/sh
# Verifies that the shared-rules block of every skill is byte-identical to
# tests/shared/shared-rules.md (D29: no file sharing between skills; a CI check
# keeps the duplicated section from drifting).
#
# usage: check-shared.sh [--root DIR] [skill-name ...]
#   --root DIR   repository root (default: two directories above this script)
#   skill-name   check only these skills; default: every skills/*/SKILL.md that exists
#
# Also: skills/<name>/scripts/ecosystems.{sh,mjs} and references/ecosystems.{json,tsv}, when present, equal control-plane/agents/ (A173).
# Also: skills/<name>/references/WRITING.md and scripts/check-writing.mjs, when present, equal tests/shared/writing-profile.md and check-writing.mjs.
#
# Block = from the line starting with `<!-- proofline:shared-rules:begin` through the line
# `<!-- proofline:shared-rules:end -->`, both included.
# Prints PASS or FAIL per skill. Exit 0 when every checked skill passes, 1 on drift, a
# missing block or a missing SKILL.md, 2 on a usage error or when there is nothing to check.

root=$(cd "$(dirname "$0")/../.." && pwd)
names=""
while [ $# -gt 0 ]; do
  case $1 in
    --root)
      [ $# -ge 2 ] || { echo "check-shared: --root needs a directory" >&2; exit 2; }
      root=$(cd "$2" 2>/dev/null && pwd) || { echo "check-shared: no such directory: $2" >&2; exit 2; }
      shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    -*) echo "check-shared: unknown option: $1" >&2; exit 2 ;;
    *) names="$names $1"; shift ;;
  esac
done

canon="$root/tests/shared/shared-rules.md"
[ -f "$canon" ] || { echo "check-shared: missing $canon" >&2; exit 2; }

if [ -z "$names" ]; then
  for f in "$root"/skills/*/SKILL.md; do
    [ -f "$f" ] || continue
    d=${f%/SKILL.md}
    names="$names ${d##*/}"
  done
fi
[ -n "$names" ] || { echo "check-shared: no skills to check under $root/skills" >&2; exit 2; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/check-shared-XXXXXX") || exit 2
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
status=0
for name in $names; do
  skill="$root/skills/$name/SKILL.md"
  if [ ! -f "$skill" ]; then
    echo "FAIL $name (SKILL.md not found)"; status=1; continue
  fi
  if ! grep -q '^<!-- proofline:shared-rules:begin' "$skill"; then
    echo "FAIL $name (shared-rules block missing)"; status=1; continue
  fi
  sed -n '/^<!-- proofline:shared-rules:begin/,/^<!-- proofline:shared-rules:end -->$/p' "$skill" > "$tmp/block"
  if cmp -s "$tmp/block" "$canon"; then
    echo "PASS $name"
  else
    echo "FAIL $name (shared-rules block differs from tests/shared/shared-rules.md)"; status=1
  fi
done
# Writing-profile copies (A138): a skill that carries the reference or the length check carries the canonical bytes.
for name in $names; do
  for pair in references/WRITING.md:writing-profile.md scripts/check-writing.mjs:check-writing.mjs; do
    f="$root/skills/$name/${pair%%:*}"
    [ -f "$f" ] || continue
    if cmp -s "$f" "$root/tests/shared/${pair##*:}"; then echo "PASS $name ${pair%%:*}"
    else echo "FAIL $name (${pair%%:*} differs from tests/shared/${pair##*:})"; status=1; fi
  done
done
# Evidence validator copies: every skill that carries validate-product-claims.mjs carries product-spec's bytes.
for f in "$root"/skills/*/scripts/validate-product-claims.mjs; do
  [ -f "$f" ] || continue
  name=${f%/scripts/validate-product-claims.mjs}; name=${name##*/}
  [ "$name" = product-spec ] && continue
  if cmp -s "$f" "$root/skills/product-spec/scripts/validate-product-claims.mjs"; then echo "PASS $name scripts/validate-product-claims.mjs"
  else echo "FAIL $name (scripts/validate-product-claims.mjs differs from skills/product-spec/scripts/validate-product-claims.mjs)"; status=1; fi
done
# Product reference copies: the quality bar is the same in the three product skills, the evidence model in the two that carry it.
for name in product-discovery product-assess; do
  for ref in QUALITY-BAR.md EVIDENCE.md; do
    f="$root/skills/$name/references/$ref"
    [ -f "$f" ] || continue
    if cmp -s "$f" "$root/skills/product-spec/references/$ref"; then echo "PASS $name references/$ref"
    else echo "FAIL $name (references/$ref differs from skills/product-spec/references/$ref)"; status=1; fi
  done
done
# Ecosystem definition copies (A173): control-plane/agents holds the canonical ecosystems.json, ecosystems.tsv (generated),
# ecosystems.mjs and scripts/ecosystems.sh; a skill that carries one carries the same bytes (it is installable alone).
# The canonical flat file must also be what `node ecosystems.mjs write` produces, and the definition must pass its schema.
eco="$root/control-plane/agents"
if [ -f "$eco/ecosystems.json" ]; then
  if command -v node >/dev/null 2>&1; then
    if node "$eco/ecosystems.mjs" check 2>"$tmp/eco.err"; then echo "PASS control-plane ecosystems.json and ecosystems.tsv"
    else echo "FAIL control-plane ecosystems definition ($(tr '\n' ' ' < "$tmp/eco.err"))"; status=1; fi
  fi
  for name in $names; do
    for pair in scripts/ecosystems.sh:scripts/ecosystems.sh scripts/ecosystems.mjs:ecosystems.mjs references/ecosystems.json:ecosystems.json references/ecosystems.tsv:ecosystems.tsv; do
      f="$root/skills/$name/${pair%%:*}"
      if [ ! -f "$f" ]; then
        # a skill whose own scripts import the definition must carry the copy it imports (it is installable alone): a missing copy fails
        case "${pair%%:*}" in scripts/ecosystems.sh|references/ecosystems.tsv) imp=ecosystems.sh ;; *) imp=ecosystems.mjs ;; esac
        if grep -lE "$imp" "$root/skills/$name"/scripts/* 2>/dev/null | grep -vE '/ecosystems\.(mjs|sh)$' | grep -q .; then
          echo "FAIL $name (${pair%%:*} is missing: a script of the skill uses $imp, and a skill is installable alone)"; status=1
        fi
        continue
      fi
      if cmp -s "$f" "$eco/${pair##*:}"; then echo "PASS $name ${pair%%:*}"
      else echo "FAIL $name (${pair%%:*} differs from control-plane/agents/${pair##*:})"; status=1; fi
    done
  done
fi
# Config reader copies (A173): the CLI (bin/lib/config.sh, cfg_lines) and the control plane (agent.sh, config_lines) are installed
# separately, so each keeps the awk program that turns config.yaml into `dotted.key=value` lines (and `key.N=item` for a block
# list of commands); the two programs must stay the same text.
cfg_awk() { sed -n "/^$2() {/,/^}/p" "$1" | sed -n "/awk '\$/,/}' /p" | sed '1d;$d'; }
if [ -f "$root/bin/lib/config.sh" ] && [ -f "$root/control-plane/agents/scripts/agent.sh" ]; then
  cfg_awk "$root/bin/lib/config.sh" cfg_lines > "$tmp/cfg-cli.awk"; cfg_awk "$root/control-plane/agents/scripts/agent.sh" config_lines > "$tmp/cfg-cp.awk"
  if [ -s "$tmp/cfg-cli.awk" ] && cmp -s "$tmp/cfg-cli.awk" "$tmp/cfg-cp.awk"; then echo "PASS config reader (bin/lib/config.sh cfg_lines = agent.sh config_lines)"
  else echo "FAIL config reader (the awk of bin/lib/config.sh cfg_lines differs from agent.sh config_lines)"; status=1; fi
fi
exit $status
