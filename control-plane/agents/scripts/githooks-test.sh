#!/bin/sh
# shellcheck disable=SC2015 # ok/no chains each print one line
# Tests for githooks/pre-commit and githooks/pre-push in throwaway repositories with a stub agent.sh.
# Never touches global or system git config (GIT_CONFIG_GLOBAL/NOSYSTEM, per-command -c only).
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/githooks-test.XXXXXX") || { echo "TMPDIR must be an existing directory: ${TMPDIR:-/tmp}" >&2; exit 2; }; trap 'rm -rf "$tmp"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 PROOFLINE_NO_TTY=1
unset AGENT_ROLE GIT_AUTHOR_EMAIL GIT_COMMITTER_EMAIL 2>/dev/null || true
fails=0
ok() { echo "PASS $1"; }
no() { echo "FAIL $1"; fails=$((fails + 1)); }
r=$tmp/repo; st=$r/.agents/local/stub
EMAIL=alice@example.org
g() { git -C "$r" -c core.hooksPath=.agents/githooks -c user.name=Test -c user.email="$EMAIL" -c commit.gpgsign=false "$@"; }
try() { rc=0; g "$@" >"$tmp/out" 2>&1 || rc=$?; }
commit() { echo "$1" >> "$r/file.txt"; g add file.txt; try commit -q -m "$1"; }
said() { grep -q "$1" "$tmp/out"; }

git init -q -b work "$r"
git clone -q --bare "$r" "$tmp/remote.git" 2>/dev/null || git init -q --bare "$tmp/remote.git"
mkdir -p "$r/.agents/scripts" "$r/.agents/runs/T-1" "$st"
cp -R "$here/../githooks" "$r/.agents/githooks"
cat > "$r/.agents/config.yaml" <<'EOF'
git:
  protected_branches: main release/*
  push_requires_approval: true
  forbidden_identities: *@example-corp.com ^ops@legacy-corp\.example$
EOF
cat > "$r/.agents/scripts/agent.sh" <<'EOF'
#!/bin/sh
st=$(dirname "$0")/../local/stub
echo "$*" >> "$st/calls.log"
case "$1" in
  open-runs) if [ -f "$st/active" ]; then echo "$(cat "$st/active") proofline/T-1-x"; fi ;;
  delivery-check) [ -f "$st/gates_ok" ] ;;
  fingerprint) echo fp-123 ;;
  approval-consume) [ -f "$st/approve_$3" ] && rm "$st/approve_$3" ;;
esac
EOF
chmod +x "$r/.agents/scripts/agent.sh"
printf 'repository:\n  task_branch: proofline/T-1-x\n' > "$r/.agents/runs/T-1/RUN.yaml"
printf '.agents/local/\n.agents/runs/\n' > "$r/.gitignore"
g add -A; g -c core.hooksPath=/dev/null commit -q -m init
g remote add origin "$tmp/remote.git"

EMAIL=dev@example-corp.com; commit a; EMAIL=alice@example.org
[ "$rc" -ne 0 ] && said git.forbidden_identities && ok "forbidden author identity blocked" || no "forbidden author identity blocked"
grep -q 'example-corp' "$tmp/out" && no "block message never prints the patterns" || ok "block message never prints the patterns"
EMAIL=OPS@Legacy-Corp.example; commit a2; EMAIL=alice@example.org
[ "$rc" -ne 0 ] && ok "forbidden identity by case-insensitive ERE blocked" || no "forbidden identity by case-insensitive ERE blocked"
rc=0; echo b >> "$r/file.txt"; g add file.txt
export GIT_COMMITTER_EMAIL=dev@example-corp.com; g commit -q -m b >"$tmp/out" 2>&1 || rc=$?; unset GIT_COMMITTER_EMAIL
[ "$rc" -ne 0 ] && said committer && ok "forbidden committer identity blocked" || no "forbidden committer identity blocked"
commit c
[ "$rc" -eq 0 ] && ok "allowed identity commits" || no "allowed identity commits ($(cat "$tmp/out"))"

g checkout -q -b release/1; commit d
[ "$rc" -ne 0 ] && said protected_branches && ok "protected branch commit blocked" || no "protected branch commit blocked"
g checkout -q work

g branch side; try push -q origin side
[ "$rc" -ne 0 ] && said push_requires_approval && ok "push without approval blocked" || no "push without approval blocked"
grep -q '^approval-consume - push' "$st/calls.log" && ok "outside a run the push approval is asked with '-'" || no "outside a run the push approval is asked with '-'"
touch "$st/approve_push"; try push -q origin work
[ "$rc" -eq 0 ] && [ ! -f "$st/approve_push" ] && ok "push with approval passes and consumes it" || no "push with approval passes and consumes it ($(cat "$tmp/out"))"
touch "$st/approve_push"; try push -q origin work:main
[ "$rc" -ne 0 ] && said protected_branches && ok "push to a protected branch blocked even with approval" || no "push to a protected branch blocked even with approval"
sed 's/push_requires_approval: true/push_requires_approval: false/' "$r/.agents/config.yaml" > "$tmp/c" && cp "$tmp/c" "$r/.agents/config.yaml"
g add .agents/config.yaml; g -c core.hooksPath=/dev/null commit -q -m cfg
rm -f "$st/approve_push"; commit e; try push -q origin work
[ "$rc" -eq 0 ] && ok "push_requires_approval false needs no approval" || no "push_requires_approval false needs no approval"

echo T-1 > "$st/active"
commit f
[ "$rc" -ne 0 ] && said "task branch" && ok "active run: commit off the task branch blocked" || no "active run: commit off the task branch blocked"
g checkout -q -b proofline/T-1-x
commit g
[ "$rc" -ne 0 ] && said delivery-ready && ok "active run: commit without passing gates blocked" || no "active run: commit without passing gates blocked"
touch "$st/gates_ok"; commit h
[ "$rc" -ne 0 ] && said "commit approval" && ok "active run: commit without approval blocked" || no "active run: commit without approval blocked"
touch "$st/approve_commit"; echo partial > "$r/other.txt"; commit i
[ "$rc" -ne 0 ] && said "exactly the gated content" && ok "active run: untracked content outside the commit blocked" || no "active run: untracked content outside the commit blocked"
rm -f "$r/other.txt"; commit j
[ "$rc" -eq 0 ] && [ ! -f "$st/approve_commit" ] && grep -q '^approval-consume T-1 commit fp-123' "$st/calls.log" && ok "active run: gated, approved commit passes" || no "active run: gated, approved commit passes ($(cat "$tmp/out"))"
EMAIL=dev@example-corp.com; touch "$st/approve_commit"; commit k; EMAIL=alice@example.org
[ "$rc" -ne 0 ] && said forbidden_identities && ok "identity guard applies inside a run too" || no "identity guard applies inside a run too"

# open runs come from `agent.sh open-runs` (never ACTIVE_RUN): only the run's task branch is pushed
g branch side; try push -q origin side
[ "$rc" -ne 0 ] && said "only its task branch" && ok "open run: push of another branch blocked" || no "open run: push of another branch blocked ($(cat "$tmp/out"))"
try push -q origin proofline/T-1-x
[ "$rc" -eq 0 ] && ok "open run: push of its task branch passes" || no "open run: push of its task branch passes ($(cat "$tmp/out"))"
! grep -q '^status' "$st/calls.log" && ok "hooks never consult ACTIVE_RUN (agent.sh status)" || no "hooks never consult ACTIVE_RUN (agent.sh status)"

[ "$fails" -eq 0 ]
