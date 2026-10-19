#!/bin/sh
# shellcheck disable=SC2015,SC2016,SC2012,SC2086 # assertion chains; literal command text; split flag string; ls of generated names
# shellcheck source-path=SCRIPTDIR
# CLI tests (D27 layer 1): bin/proofline init, upgrade, doctor and the state commands in throwaway
# repositories under $TMPDIR, with fake claude/codex binaries on PATH and a private HOME / global git config.
# Prints `ok N - ...` per case and stops at the first failure.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo=$(CDPATH='' cd "$here/../.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/proofline-cli.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT HUP INT TERM
# The CLI under test runs from a snapshot of the checkout, so edits made to the tree while this long suite
# runs cannot make two installs differ.
snap=$T/snap; mkdir -p "$snap"
for d in bin control-plane adapters skills roles; do cp -R "$repo/$d" "$snap/"; done
PL=$snap/bin/proofline
n=0
ok() { n=$((n + 1)); printf 'ok %s - %s\n' "$n" "$*"; }
die() { printf 'FAIL: %s\n' "$*" >&2; [ -z "${LAST:-}" ] || printf '%s\n' "$LAST" | tail -n 25 | sed 's/^/    | /' >&2; exit 1; }
# check DESC CMD...: the command must succeed
check() { c_d=$1; shift; "$@" >/dev/null 2>&1 || die "$c_d"; ok "$c_d"; }
# nocheck DESC CMD...: the command must fail
nocheck() { c_d=$1; shift; if "$@" >/dev/null 2>&1; then die "$c_d"; fi; ok "$c_d"; }
has() { printf '%s' "$1" | grep -qF -- "$2"; }
# expect DESC TEXT NEEDLE
expect() { has "$2" "$3" || { LAST=$2; die "$1 (missing: $3)"; }; ok "$1"; }
reject() { if has "$2" "$3"; then LAST=$2; die "$1 (found: $3)"; fi; ok "$1"; }

REAL_CLAUDE=$(command -v claude 2>/dev/null || true)
mkdir -p "$T/fakebin" "$T/home"
cat > "$T/fakebin/claude" <<'EOF'
#!/bin/sh
case "${1:-}" in --version) echo "9.9.9 (Claude Code, fake)" ;; esac
exit 0
EOF
cat > "$T/fakebin/codex" <<'EOF'
#!/bin/sh
case "${1:-}" in --version) echo "codex-cli 9.9.9 (fake)" ;; esac
exit 0
EOF
chmod +x "$T/fakebin/claude" "$T/fakebin/codex"
PATH="$T/fakebin:$PATH"; export PATH
HOME=$T/home; export HOME
printf '[user]\n\tname = Global User\n\temail = global@example.test\n' > "$T/home/.gitconfig-global"
GIT_CONFIG_GLOBAL=$T/home/.gitconfig-global; GIT_CONFIG_NOSYSTEM=1; export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE AGENT_ROLE CLAUDE_PROJECT_DIR PROOFLINE_PROMPT PROOFLINE_RUNTIMES PROOFLINE_LEAD
PROOFLINE_NO_TTY=1; export PROOFLINE_NO_TTY
global_sha=$(shasum -a 256 "$GIT_CONFIG_GLOBAL" | awk '{print $1}')

mkrepo() { # NAME -> path of a fresh repository with a repository-local identity and one commit
  mr=$T/$1; mkdir -p "$mr"
  git -C "$mr" init -q -b main
  git -C "$mr" config user.name Dev; git -C "$mr" config user.email dev@example.test; git -C "$mr" config commit.gpgsign false
  printf '# app\n' > "$mr/README.md"
  git -C "$mr" add README.md; git -C "$mr" commit -q -m init
  printf '%s\n' "$mr"
}
pl() { ( cd "$1" && shift && sh "$PL" "$@" ); }          # pl DIR ARGS...
cfgv() { ( cd "$1" && sh .agents/scripts/agent.sh config-get "$2" ); }
sig() { ( cd "$1" && find . -path ./.git -prune -o -type f -print | sort | while read -r f; do printf '%s %s\n' "$f" "$(shasum -a 256 "$f" | awk '{print $1}')"; done ); }
jqe() { jq -e "$1" "$2" >/dev/null 2>&1; }

# ---- version, help ---------------------------------------------------------------------------------------
out=$(sh "$PL" version); expect "version prints proofline 0.0.7" "$out" "proofline 0.0.7"
[ "$(jq -r .version "$repo/.claude-plugin/plugin.json")" = 0.0.7 ] && ok "plugin.json version equals the CLI version" || die "plugin.json version differs from the CLI"
out=$(sh "$PL" help); expect "help lists init, upgrade, doctor" "$out" "doctor"
nocheck "an unknown command fails" sh "$PL" frobnicate
nocheck "status outside an installed project fails" pl "$(mkrepo bare)" status

# ---- init: everything installed --------------------------------------------------------------------------
base=$(mkrepo base)
printf '{"scripts":{"build":"tsc","test":"jest","lint":"eslint ."}}\n' > "$base/package.json"
INIT_FLAGS="--yes --runtimes claude,codex --lead claude --worker codex --reviewers claude --profile economy --task-adapter markdown --protected-branches release --push-approval true --forbidden-identity *@forbidden-zz.test --forbidden-identity *@other-zz.test"
# shellcheck disable=SC2086 # the flag string is split on purpose; the patterns contain no spaces
set -f; out=$(pl "$base" init $INIT_FLAGS 2>&1) || { LAST=$out; die "init exits 0"; }; set +f
ok "init --yes with flags exits 0"
expect "init discovered the build command from package.json" "$out" "build='npm run build'"
[ "$(cfgv "$base" runtime.worker)" = codex ] && [ "$(cfgv "$base" runtime.lead)" = claude ] && ok "config: runtimes from flags" || die "config runtimes"
[ "$(cfgv "$base" profile)" = economy ] && [ "$(cfgv "$base" git.protected_branches)" = release ] && ok "config: profile and protected branches" || die "config profile / protected branches"
[ "$(cfgv "$base" git.forbidden_identities)" = '*@forbidden-zz.test *@other-zz.test' ] && ok "config: two forbidden identities (repeatable flag)" || die "config forbidden identities: $(cfgv "$base" git.forbidden_identities)"
[ "$(cfgv "$base" commands.test)" = "npm test" ] && [ "$(cfgv "$base" commands.lint)" = "npm run lint" ] && [ "$(cfgv "$base" canonical_branch)" = main ] && ok "config: discovered commands and canonical branch" || die "config commands / canonical branch"
[ "$(cfgv "$base" proofline_version)" = 0.0.7 ] && ok "config: proofline_version stamped" || die "proofline_version"
check "agent.sh config-check accepts the installed config" sh -c "cd '$base' && sh .agents/scripts/agent.sh config-check"
for f in .agents/scripts/agent.sh .agents/scripts/dispatch.sh .agents/githooks/pre-commit .agents/githooks/pre-push; do
  [ -x "$base/$f" ] || die "$f is not executable"
done; ok "scripts and git hooks are executable"
for f in .agents/WORKFLOW.md .agents/GATES.md .agents/templates/RUN.yaml .agents/modes/deterministic.yaml .agents/hooks/proofline-hook.sh .agents/roles.conf .agents/roles/lead.md \
  .claude/agents/proofline-reviewer.md .codex/agents/proofline-reviewer.toml AGENTS.md CLAUDE.md .claude/settings.json .codex/hooks.json .agents/.proofline-manifest; do
  [ -f "$base/$f" ] || die "missing after init: $f"
done; ok "control plane, roles, agents, hooks and instruction files are installed"
[ -z "$(find "$base" -name '*.proofline-new' -not -path '*/.git/*' | head -1)" ] && ok "no stray .proofline-new after a clean init" || die "stray .proofline-new"
miss=''; cnt=0
for d in "$repo"/skills/*/; do
  s=$(basename "$d"); [ -f "$d/SKILL.md" ] || continue
  cnt=$((cnt + 1)); [ -f "$base/.agents/skills/$s/SKILL.md" ] || miss="$miss $s"
done
[ -z "$miss" ] && [ "$cnt" -ge 18 ] && ok "every skill ($cnt, including proofline) is installed in .agents/skills" || die "skills missing:$miss ($cnt)"
[ -f "$base/.claude/skills/proofline/SKILL.md" ] && ok "the /proofline entry skill is installed for Claude (.claude/skills/proofline)" || die ".claude/skills/proofline missing"
gen=$T/gen-economy; sh "$snap/adapters/generate.sh" --profile economy --out "$gen" >/dev/null 2>&1 || die "generator failed"
diff -r "$gen/.claude/agents" "$base/.claude/agents" >/dev/null 2>&1 && diff -r "$gen/.codex/agents" "$base/.codex/agents" >/dev/null 2>&1 && diff "$gen/.agents/roles.conf" "$base/.agents/roles.conf" >/dev/null 2>&1 \
  && ok "roles are rendered for the chosen profile (equals generate.sh --profile economy)" || die "installed roles differ from generate.sh --profile economy"
bad=''
for ev in SessionStart UserPromptSubmit PreToolUse PostToolUse SubagentStart SubagentStop; do
  jqe ".hooks.$ev | map(.hooks[].command) | flatten | any(contains(\"proofline-hook.sh\"))" "$base/.claude/settings.json" || bad="$bad claude:$ev"
  jqe ".hooks.$ev | map(.hooks[].command) | flatten | any(contains(\"proofline-hook.sh\"))" "$base/.codex/hooks.json" || bad="$bad codex:$ev"
done
[ -z "$bad" ] && ok "Claude settings and Codex hooks wire all six events" || die "hooks missing:$bad"
grep -qx '<!-- proofline:begin -->' "$base/AGENTS.md" && grep -qx '<!-- proofline:end -->' "$base/AGENTS.md" && grep -qx '<!-- proofline:begin -->' "$base/CLAUDE.md" && ok "AGENTS.md and CLAUDE.md carry the marked proofline block" || die "marked blocks missing"
grep -qxF .agents/local/ "$base/.gitignore" && grep -qxF .agents/runs/ "$base/.gitignore" && ok ".gitignore ignores .agents/local/ and .agents/runs/" || die ".gitignore lines missing"
! grep -Eq '^/?\.claude(/|$)' "$base/.gitignore" && ok ".gitignore of an installed project has no .claude line (A117)" || die "init added a .claude line to .gitignore"
[ "$(git -C "$base" config --local --get core.hooksPath)" = .agents/githooks ] && ok "core.hooksPath is set locally" || die "core.hooksPath not set locally"
[ -z "$(git config --global --get core.hooksPath 2>/dev/null || true)" ] && [ "$(shasum -a 256 "$GIT_CONFIG_GLOBAL" | awk '{print $1}')" = "$global_sha" ] && ok "global git configuration is untouched" || die "global git config changed"
bad=''
while read -r s p; do [ "$(shasum -a 256 "$base/$p" | awk '{print $1}')" = "$s" ] || bad="$bad $p"; done <<EOF
$(grep -v '^#' "$base/.agents/.proofline-manifest")
EOF
[ -z "$bad" ] && [ "$(grep -vc '^#' "$base/.agents/.proofline-manifest")" -gt 100 ] && grep -q '^# version: 0.0.7' "$base/.agents/.proofline-manifest" && ok "manifest lists every installed file with its sha256 and the version" || die "manifest wrong:$bad"

# ---- init: idempotent -------------------------------------------------------------------------------------
before=$(sig "$base"); cp "$base/.agents/.proofline-manifest" "$T/manifest.before"
set -f; out=$(pl "$base" init $INIT_FLAGS 2>&1); set +f
after=$(sig "$base")
[ "$before" = "$after" ] && ok "a second init changes no file" || { LAST="$out
$(diff "$T/manifest.before" "$base/.agents/.proofline-manifest" | head -10)"; die "second init changed files"; }
expect "a second init reports no changes" "$out" "no changes"
grep -qxF .agents/local/ "$base/.gitignore" && grep -qxF .agents/runs/ "$base/.gitignore" && ! grep -Eq '^/?\.claude(/|$)' "$base/.gitignore" && ok "after a second init .gitignore still has no .claude line (A117)" || die "second init changed .gitignore wrongly"

# ---- init: merges, never overwrites ----------------------------------------------------------------------
pre=$(mkrepo pre)
printf '# My agents\nkeep me\n' > "$pre/AGENTS.md"
printf 'my claude notes' > "$pre/CLAUDE.md"
printf 'node_modules\n' > "$pre/.gitignore"
mkdir -p "$pre/.claude" "$pre/.codex"
printf '{"permissions":{"allow":["Bash(ls)"]},"model":"opus","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo mine"}]}]}}\n' > "$pre/.claude/settings.json"
printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo codex-mine"}]}]},"extra":1}\n' > "$pre/.codex/hooks.json"
printf 'model = "user-model"\n[sandbox_workspace_write]\ncustom = "mine"\nnetwork_access = false\n' > "$pre/.codex/config.toml"
out=$(pl "$pre" init --yes --runtimes claude,codex 2>&1) || { LAST=$out; die "init into a project with existing files"; }
[ "$(sed -n 1,2p "$pre/AGENTS.md")" = "$(printf '# My agents\nkeep me')" ] && grep -qx '<!-- proofline:begin -->' "$pre/AGENTS.md" && ok "AGENTS.md: user content first and intact, proofline block appended" || die "AGENTS.md overwritten"
[ "$(sed -n 1p "$pre/CLAUDE.md")" = "my claude notes" ] && grep -qx '<!-- proofline:end -->' "$pre/CLAUDE.md" && ok "CLAUDE.md: user content kept, block appended" || die "CLAUDE.md overwritten"
grep -qx node_modules "$pre/.gitignore" && grep -qxF .agents/runs/ "$pre/.gitignore" && ok ".gitignore: existing lines kept" || die ".gitignore overwritten"
grep -qxF .agents/local/ "$pre/.gitignore" && ! grep -Eq '^/?\.claude(/|$)' "$pre/.gitignore" && ok ".gitignore: init adds no .claude line to an existing file (A117)" || die "init added .claude to an existing .gitignore"
jqe '.permissions.allow[0] == "Bash(ls)" and .model == "opus"' "$pre/.claude/settings.json" && ok ".claude/settings.json keeps the user's keys" || die "settings.json keys dropped"
jqe '[.hooks.PreToolUse[].hooks[].command] | (index("echo mine") != null) and (map(select(contains("proofline-hook.sh"))) | length == 1)' "$pre/.claude/settings.json" && ok ".claude/settings.json keeps the user's hook and adds one proofline hook" || die "settings.json hooks wrong"
jqe '.extra == 1 and ([.hooks.SessionStart[].hooks[].command] | index("echo codex-mine") != null)' "$pre/.codex/hooks.json" && jqe '.hooks.SubagentStop | length >= 1' "$pre/.codex/hooks.json" && ok ".codex/hooks.json is merged, not replaced" || die "codex hooks.json not merged"
grep -Fqx 'network_access = true' "$pre/.codex/config.toml" && grep -Fqx 'custom = "mine"' "$pre/.codex/config.toml" && grep -Fqx 'model = "user-model"' "$pre/.codex/config.toml" && grep -Fq '# toml-.codex/config.toml:' "$pre/.agents/.proofline-manifest" && ok '.codex/config.toml enables network, keeps user keys, and is manifest-tracked' || die 'codex config.toml merge failed'
s1=$(sig "$pre"); out=$(pl "$pre" init --yes --runtimes claude,codex 2>&1); [ "$s1" = "$(sig "$pre")" ] && ok "re-running init on a merged project changes nothing (no duplicated hooks or blocks)" || { LAST=$out; die "merged project not idempotent"; }
printf '{ not json' > "$pre/.claude/settings.json"
out=$(pl "$pre" init --yes --runtimes claude,codex 2>&1); [ "$(cat "$pre/.claude/settings.json")" = '{ not json' ] && expect "invalid settings.json is left alone with a warning" "$out" "not merged" || die "invalid settings.json overwritten"

# CLI-10: a codex-only install creates no .claude/ files
cx=$(mkrepo codexonly); pl "$cx" init --yes --runtimes codex >/dev/null 2>&1 || die "codex-only init failed"
[ ! -e "$cx/.claude" ] && [ ! -e "$cx/CLAUDE.md" ] && [ -f "$cx/.codex/hooks.json" ] && ok "a codex-only init creates no .claude/ and no CLAUDE.md" || die "codex-only init wrote .claude: $(ls -A "$cx")"
grep -Fqx 'network_access = true' "$cx/.codex/config.toml" && ok 'codex-only init enables workspace-write network' || die 'codex-only network setting missing'
cl=$(mkrepo claudeonly); pl "$cl" init --yes --runtimes claude >/dev/null 2>&1 || die 'claude-only init failed'
[ ! -e "$cl/.codex/config.toml" ] && ok 'init without codex omits the network setting' || die 'claude-only init wrote codex config'

# ---- init: dry run writes nothing ------------------------------------------------------------------------
dry=$(mkrepo dry); s1=$(sig "$dry")
out=$(pl "$dry" init --yes --dry-run --runtimes claude 2>&1) || { LAST=$out; die "init --dry-run exits 0"; }
[ "$s1" = "$(sig "$dry")" ] && [ ! -e "$dry/.agents" ] && [ -z "$(git -C "$dry" config --local --get core.hooksPath || true)" ] && ok "--dry-run writes nothing (no files, no git config)" || die "--dry-run wrote something"
expect "--dry-run prints the plan" "$out" "dry run"; expect "--dry-run lists the control plane" "$out" ".agents/scripts"

# ---- init: errors ------------------------------------------------------------------------------------------
nocheck "init outside a git repository fails" sh -c "mkdir -p '$T/nogit' && cd '$T/nogit' && sh '$PL' init --yes"
nocheck "init rejects an unknown profile" pl "$(mkrepo badprof)" init --yes --runtimes claude --profile turbo
nocheck "init rejects a lead runtime that is not in --runtimes" pl "$(mkrepo badlead)" init --yes --runtimes claude --lead codex

# ---- upgrade -----------------------------------------------------------------------------------------------
up=$T/up; cp -R "$base" "$up"
home2=$T/home2; mkdir -p "$home2"
for d in bin control-plane adapters skills roles; do cp -R "$snap/$d" "$home2/"; done
echo "upstream change in GATES" >> "$home2/control-plane/agents/GATES.md"
echo "upstream change in WORKFLOW" >> "$home2/control-plane/agents/WORKFLOW.md"
echo "new file" > "$home2/control-plane/agents/NEWFILE.md"
awk '{ print } /^budgets:/ { print "  new_budget: 7" }' "$home2/control-plane/agents/config.yaml" > "$home2/cfg.tmp" && cat "$home2/cfg.tmp" > "$home2/control-plane/agents/config.yaml"
echo "my own workflow note" >> "$up/.agents/WORKFLOW.md"
( cd "$up" && sh .agents/scripts/agent.sh config-get review.max_fix_rounds >/dev/null )
awk '/^  max_fix_rounds:/ { print "  max_fix_rounds: 5"; next } { print }' "$up/.agents/config.yaml" > "$up/cfg.tmp" && cat "$up/cfg.tmp" > "$up/.agents/config.yaml" && rm "$up/cfg.tmp"
s1=$(sig "$up"); out=$(cd "$up" && sh "$home2/bin/proofline" upgrade --dry-run 2>&1)
[ "$s1" = "$(sig "$up")" ] && ok "upgrade --dry-run writes nothing" || die "upgrade --dry-run wrote files"
out=$(cd "$up" && sh "$home2/bin/proofline" upgrade 2>&1) || { LAST=$out; die "upgrade exits 0"; }
ok "upgrade exits 0"
grep -q "upstream change in GATES" "$up/.agents/GATES.md" && expect "upgrade updates an unmodified file" "$out" "updated   .agents/GATES.md" || die "unmodified GATES.md not updated"
grep -q "my own workflow note" "$up/.agents/WORKFLOW.md" && ! grep -q "upstream change in WORKFLOW" "$up/.agents/WORKFLOW.md" && ok "upgrade keeps a user-modified file" || die "user-modified WORKFLOW.md overwritten"
grep -q "upstream change in WORKFLOW" "$up/.agents/WORKFLOW.md.proofline-new" && expect "upgrade reports the conflict and writes a .proofline-new copy" "$out" "CONFLICT  .agents/WORKFLOW.md" || die "conflict not reported"
[ -f "$up/.agents/NEWFILE.md" ] && ok "upgrade installs a file that is new in this version" || die "NEWFILE.md missing"
[ "$(cfgv "$up" budgets.new_budget)" = 7 ] && [ "$(cfgv "$up" review.max_fix_rounds)" = 5 ] && [ "$(cfgv "$up" runtime.worker)" = codex ] && ok "upgrade adds new config keys and keeps the user's values" || die "config merge wrong"
check "the upgraded config still validates" sh -c "cd '$up' && sh .agents/scripts/agent.sh config-check"
echo "my edit of an unchanged-upstream file" >> "$up/.agents/ENGINEERING.md"
out=$(cd "$up" && sh "$home2/bin/proofline" upgrade 2>&1)
reject "a user edit of a file upstream did not change is not a conflict" "$out" "CONFLICT  .agents/ENGINEERING.md"
grep -q "my edit of an unchanged-upstream file" "$up/.agents/ENGINEERING.md" && ok "...and it is kept" || die "ENGINEERING.md edit lost"
nocheck "upgrade without an install fails" pl "$(mkrepo noinst)" upgrade

# CLI-7: the proofline block of AGENTS.md is hash-tracked; a user edit inside it is a conflict, never overwritten
up2=$T/up2; cp -R "$base" "$up2"
echo "upstream block change" >> "$home2/control-plane/AGENTS.md"
out=$(cd "$up2" && sh "$home2/bin/proofline" upgrade 2>&1) || { LAST=$out; die "upgrade with a new block exits 0"; }
grep -q "upstream block change" "$up2/AGENTS.md" && [ ! -e "$up2/AGENTS.md.proofline-new" ] && reject "an unedited block updates without a conflict" "$out" "CONFLICT  AGENTS.md" || { LAST=$out; die "unedited block not updated cleanly"; }
up3=$T/up3; cp -R "$base" "$up3"
awk '/^<!-- proofline:end -->$/ { print "my own rule inside the block" } { print }' "$up3/AGENTS.md" > "$up3/a.tmp" && mv "$up3/a.tmp" "$up3/AGENTS.md"
printf 'outside note\n' >> "$up3/AGENTS.md"
a_before=$(cat "$up3/AGENTS.md")
out=$(cd "$up3" && sh "$home2/bin/proofline" upgrade 2>&1) || { LAST=$out; die "upgrade with an edited block exits 0"; }
expect "an edit inside the proofline block is reported as a conflict" "$out" "CONFLICT  AGENTS.md"
[ "$(cat "$up3/AGENTS.md")" = "$a_before" ] && grep -q "upstream block change" "$up3/AGENTS.md.proofline-new" && ok "...the user's AGENTS.md is untouched and AGENTS.md.proofline-new carries the new block" || die "edited block overwritten or no .proofline-new"

# ---- doctor -------------------------------------------------------------------------------------------------
d1=$T/d1; cp -R "$base" "$d1"
out=$(pl "$d1" doctor 2>&1); rc=$?
[ "$rc" = 0 ] && ok "doctor passes on a fresh install" || { LAST=$out; die "doctor failed on a fresh install"; }
reject "doctor prints no FAIL on a fresh install" "$out" "FAIL "
expect "doctor shows the runtime versions" "$out" "runtime claude: 9.9.9"
expect "doctor runs the identity probe" "$out" "probe: pre-commit blocks a forbidden identity"
expect "doctor runs the push probe" "$out" "probe: pre-push blocks a push without approval"
expect "doctor runs the PreToolUse probe" "$out" "Claude PreToolUse hook denies a lead edit"
expect "doctor runs the Codex PreToolUse probe" "$out" "Codex PreToolUse hook denies"
expect "doctor notes the Codex hook trust step" "$out" "codex trust"
reject "doctor never prints the configured identity patterns" "$out" "forbidden-zz"
reject "doctor stays quiet about commands when all three are configured" "$out" "WARN commands"
dz=$T/dz; cp -R "$base" "$dz"; sed -e 's/^  build:.*/  build:/' -e 's/^  lint:.*/  lint:/' "$dz/.agents/config.yaml" > "$dz/cfg.tmp" && mv "$dz/cfg.tmp" "$dz/.agents/config.yaml"
out=$(pl "$dz" doctor 2>&1)
expect "doctor warns about empty commands.build and commands.lint" "$out" "WARN commands: empty in .agents/config.yaml: build lint ("
reject "doctor lists no foreign hook or skill on a clean HOME" "$out" "WARN foreign hook"
# 0.0.5: foreign context hooks and overlapping skills are listed as WARN, never FAIL, and the exit stays 0
mkdir -p "$HOME/.claude/skills/test-driven-dev" "$HOME/.claude/skills/rust-lint"
printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo foreign-ctx"}]}],"PreToolUse":[{"hooks":[{"type":"command","command":"echo not-listed"}]}]}}\n' > "$HOME/.claude/settings.json"
out=$(pl "$d1" doctor 2>&1); rc=$?
rm -rf "$HOME/.claude"
[ "$rc" = 0 ] && expect "doctor lists a foreign SessionStart hook as WARN only" "$out" "WARN foreign hook: SessionStart in .claude/settings.json may add context to the prompt: echo foreign-ctx" || { LAST=$out; die "foreign hook: rc=$rc"; }
expect "doctor lists an overlapping skill as WARN" "$out" "WARN overlapping skill: test-driven-dev"
reject "doctor leaves ecosystem skills and other events alone" "$out" "rust-lint"
reject "doctor ignores a foreign PreToolUse hook" "$out" "not-listed"
d2=$T/d2; cp -R "$base" "$d2"; git -C "$d2" config --local --unset core.hooksPath
out=$(pl "$d2" doctor 2>&1); rc=$?
[ "$rc" != 0 ] && expect "doctor FAILs when core.hooksPath is unset" "$out" "FAIL git hooks: core.hooksPath is not set" || { LAST=$out; die "doctor passed without core.hooksPath"; }
d3=$T/d3; cp -R "$base" "$d3"; git -C "$d3" config --local user.email someone@forbidden-zz.test
out=$(pl "$d3" doctor 2>&1); rc=$?
[ "$rc" != 0 ] && expect "doctor FAILs on a forbidden commit identity" "$out" "FAIL identity" || { LAST=$out; die "doctor passed with a forbidden identity"; }
reject "...and names the config key, not the pattern" "$out" "forbidden-zz"; expect "...naming git.forbidden_identities" "$out" "git.forbidden_identities"
d4=$T/d4; cp -R "$base" "$d4"; rm "$d4/.claude/settings.json"
out=$(pl "$d4" doctor 2>&1); rc=$?
[ "$rc" != 0 ] && expect "doctor FAILs when the Claude hooks are not wired" "$out" "FAIL claude hooks" || { LAST=$out; die "doctor passed without Claude hooks"; }
d5=$T/d5; cp -R "$base" "$d5"; echo "tampered" >> "$d5/.agents/GATES.md"
out=$(pl "$d5" doctor 2>&1); expect "doctor warns about a modified installed file" "$out" "WARN manifest"
# A135: the used-runtime list keeps its spaces: a mixed config (Claude lead, Codex worker) with no codex binary still warns
d8=$T/d8; cp -R "$base" "$d8"; sed 's/^  worker: claude/  worker: codex/' "$d8/.agents/config.yaml" > "$d8/c.tmp" && mv "$d8/c.tmp" "$d8/.agents/config.yaml"
out=$(PROOFLINE_CODEX_BIN=/nonexistent/codex pl "$d8" doctor 2>&1)
expect "doctor warns that a used runtime is not installed (mixed config)" "$out" "WARN runtime codex: not installed, but config.yaml uses it"
# A135: a Codex lead on the shipped policy passes; an installed config without lead_base_model gets a warning
d9=$T/d9; cp -R "$base" "$d9"; sed 's/^  lead: claude/  lead: codex/' "$d9/.agents/config.yaml" > "$d9/c.tmp" && mv "$d9/c.tmp" "$d9/.agents/config.yaml"
out=$(pl "$d9" doctor 2>&1); expect "doctor passes a Codex lead on the base model" "$out" "PASS lead model: codex lead resolves to gpt-6-sol"
grep -v 'lead_base_model:\|^    codex: gpt-6-sol$' "$d9/.agents/config.yaml" > "$d9/c.tmp" && mv "$d9/c.tmp" "$d9/.agents/config.yaml"
out=$(pl "$d9" doctor 2>&1); expect "doctor warns when lead_base_model is absent from the installed config" "$out" "WARN lead model: .agents/config.yaml has no execution_policy.lead_base_model"
nocheck "doctor FAILs outside an installed project" pl "$(mkrepo nodoc)" doctor
# CLI-5: a missing control-plane file the manifest lists is a FAIL when critical, a WARN otherwise
d6=$T/d6; cp -R "$base" "$d6"; rm "$d6/.agents/PROTOCOL.md"
out=$(pl "$d6" doctor 2>&1); rc=$?
[ "$rc" = 0 ] && expect "doctor only WARNs when a non-critical installed file is missing" "$out" "WARN manifest: 1 installed file" || { LAST=$out; die "non-critical missing file: rc=$rc"; }
for crit in .agents/scripts/dispatch.sh .agents/owns.conf .agents/tools.conf .agents/roles.conf .agents/githooks/pre-push .agents/hooks/proofline-hook.sh .agents/skills/proofline-lead; do
  d7=$T/d7; rm -rf "$d7"; cp -R "$base" "$d7"; rm -rf "${d7:?}/$crit"
  out=$(pl "$d7" doctor 2>&1); rc=$?
  [ "$rc" != 0 ] && expect "doctor FAILs when $crit is missing" "$out" "FAIL manifest: required control-plane file missing: $crit" || { LAST=$out; die "doctor passed without $crit"; }
done
# CLI-11: a global/system core.hooksPath is warned about (init and doctor), never modified
gh_cfg=$T/home/.gitconfig-hp; cp "$GIT_CONFIG_GLOBAL" "$gh_cfg"; printf '[core]\n\thooksPath = /nonexistent/global-hooks\n' >> "$gh_cfg"
gh_sha=$(shasum -a 256 "$gh_cfg" | awk '{print $1}')
ghp=$(mkrepo ghp)
out=$(GIT_CONFIG_GLOBAL=$gh_cfg pl "$ghp" init --yes --runtimes claude 2>&1) || { LAST=$out; die "init with a global hooksPath exits 0"; }
expect "init warns about a global core.hooksPath" "$out" "global/system git core.hooksPath"
[ "$(git -C "$ghp" config --local --get core.hooksPath)" = .agents/githooks ] && [ "$(shasum -a 256 "$gh_cfg" | awk '{print $1}')" = "$gh_sha" ] && ok "...the local hooksPath is still set and the global config is untouched" || die "init changed the wrong hooksPath"
out=$(GIT_CONFIG_GLOBAL=$gh_cfg pl "$ghp" doctor 2>&1)
expect "doctor warns about a global core.hooksPath" "$out" "WARN git hooks: a global/system git core.hooksPath"

# ---- status, resume, queue, session commands, deliver, clean -----------------------------------------------
st=$T/st; cp -R "$base" "$st"
out=$(pl "$st" status 2>&1); expect "status without a run says so" "$out" "no active run"
mkdir -p "$st/.agents/runs/T-1" "$st/.agents/local" "$st/.agents/tasks/todo"
sed 's/<TASK-ID>/T-1/' "$st/.agents/templates/RUN.yaml" > "$st/.agents/runs/T-1/RUN.yaml"
echo T-1 > "$st/.agents/local/ACTIVE_RUN"; printf '# Task: T-9 - queued\n' > "$st/.agents/tasks/todo/T-9.md"
out=$(pl "$st" 2>&1); expect "no command means status" "$out" "active_task=T-1"; expect "status prints agent.sh next" "$out" "next=agent.sh classify T-1"
out=$(pl "$st" resume 2>&1); expect "resume prints agent.sh next" "$out" "next=agent.sh classify T-1"; expect "resume prints the state" "$out" "state=PLANNING"
expect "resume checks freshness" "$out" "freshness:"; expect "resume tells Claude users what to say" "$out" "/proofline resume"
out=$(pl "$st" queue 2>&1); expect "queue lists task files" "$out" "todo/T-9.md"; expect "queue lists runs and marks the active one" "$out" "* T-1"
out=$(pl "$st" run T-2 2>&1); expect "run prints the Claude instruction" "$out" "/proofline run T-2"; expect "run warns about the active run" "$out" "run T-1 is active"
out=$(pl "$st" task --grill "add a lookup" 2>&1); expect "task --grill prints the instruction" "$out" "/proofline task --grill add a lookup"
out=$(pl "$st" design api --check 2>&1); expect "design api --check prints the instruction" "$out" "/proofline design api --check"
nocheck "design with an unknown kind fails" pl "$st" design nonsense
for c in review audit debug; do out=$(pl "$st" "$c" 2>&1); expect "$c prints the instruction" "$out" "/proofline $c"; done
awk '/^  lead:/ { print "  lead: codex"; next } { print }' "$st/.agents/config.yaml" > "$st/cfg.tmp" && cat "$st/cfg.tmp" > "$st/.agents/config.yaml" && rm "$st/cfg.tmp"
out=$(pl "$st" run T-2 2>&1); expect "run prints the Codex instruction when the lead is codex" "$out" '$proofline run T-2'
out=$(pl "$st" resume 2>&1); expect "resume prints the Codex instruction" "$out" 'codex '"'"'$proofline resume'"'"
head_before=$(git -C "$st" rev-parse HEAD)
out=$(pl "$st" deliver T-1 2>&1); rc=$?
[ "$rc" != 0 ] && expect "deliver refuses a run that is not CODE_DONE" "$out" "delivery blocked" || { LAST=$out; die "deliver passed for an unfinished run"; }
[ "$(git -C "$st" rev-parse HEAD)" = "$head_before" ] && ok "deliver never commits" || die "deliver changed HEAD"
# a FAILED run: deliver offers a DRAFT pull request body from the records, never a merge
sed 's/^  state: PLANNING$/  state: FAILED/' "$st/.agents/runs/T-1/RUN.yaml" > "$st/run.tmp" && cat "$st/run.tmp" > "$st/.agents/runs/T-1/RUN.yaml" && rm "$st/run.tmp"
out=$(pl "$st" deliver T-1 2>&1); expect "deliver of a FAILED run waits for the knowledge step" "$out" "/proofline knowledge T-1"
sed 's/^  knowledge_state: .*$/  knowledge_state: not_applicable/' "$st/.agents/runs/T-1/RUN.yaml" > "$st/run.tmp" && cat "$st/run.tmp" > "$st/.agents/runs/T-1/RUN.yaml" && rm "$st/run.tmp"
out=$(pl "$st" deliver T-1 2>&1); expect "deliver of a FAILED run prepares a DRAFT pull request body" "$out" "gh pr create --draft"
expect "the draft body says it must not be merged" "$out" "Do not merge"
[ "$(git -C "$st" rev-parse HEAD)" = "$head_before" ] && ok "deliver of a FAILED run never commits" || die "deliver of a FAILED run changed HEAD"
mkdir -p "$st/.agents/local/prompts"; echo x > "$st/.agents/local/prompts/s.json"
nocheck "clean refuses without --yes (non-interactive)" pl "$st" clean
[ -f "$st/.agents/local/prompts/s.json" ] && ok "...and removes nothing" || die "clean removed files without --yes"
out=$(pl "$st" clean --yes 2>&1) || { LAST=$out; die "clean --yes exits 0"; }
[ ! -e "$st/.agents/local/prompts/s.json" ] && [ -f "$st/.agents/local/ACTIVE_RUN" ] && [ -d "$st/.agents/runs/T-1" ] && ok "clean --yes removes local state, keeps the unfinished active run" || die "clean --yes result wrong"

# ---- discovery ---------------------------------------------------------------------------------------------
say() { :; }
# shellcheck source=../../bin/lib/discover.sh
. "$repo/bin/lib/discover.sh"
fx() { rm -rf "$T/fx"; mkdir -p "$T/fx"; }
fx; printf '{"scripts":{"build":"b","test":"echo \\"Error: no test specified\\" && exit 1"}}' > "$T/fx/package.json"; : > "$T/fx/pnpm-lock.yaml"
discover_commands "$T/fx"; [ "$D_BUILD" = "pnpm run build" ] && [ -z "$D_TEST" ] && ok "discovery: package.json with pnpm; the npm placeholder test script is ignored" || die "node discovery: build='$D_BUILD' test='$D_TEST'"
fx; printf 'build:\n\tgo build\ntest:\n\tgo test\n' > "$T/fx/Makefile"
discover_commands "$T/fx"; [ "$D_BUILD" = "make build" ] && [ "$D_TEST" = "make test" ] && [ -z "$D_LINT" ] && ok "discovery: Makefile targets" || die "make discovery"
fx; : > "$T/fx/go.mod"; discover_commands "$T/fx"; [ "$D_TEST" = "go test ./..." ] && [ "$D_LINT" = "go vet ./..." ] && ok "discovery: go.mod" || die "go discovery"
fx; : > "$T/fx/Cargo.toml"; discover_commands "$T/fx"; [ "$D_TEST" = "cargo test" ] && ok "discovery: Cargo.toml" || die "cargo discovery"
fx; printf '[tool.pytest.ini_options]\n[tool.ruff]\n' > "$T/fx/pyproject.toml"; discover_commands "$T/fx"; [ "$D_TEST" = pytest ] && [ "$D_LINT" = "ruff check ." ] && ok "discovery: pyproject (pytest, ruff)" || die "python discovery"
fx; : > "$T/fx/App.csproj"; discover_commands "$T/fx"; [ "$D_TEST" = "dotnet test" ] && ok "discovery: *.csproj" || die "dotnet discovery"
fx; mkdir -p "$T/fx/.github/workflows"; printf 'jobs:\n  ci:\n    steps:\n      - run: npm run lint\n      - run: make test\n      - run: echo ${{ secrets.X }} && make build\n' > "$T/fx/.github/workflows/ci.yml"
discover_commands "$T/fx"; [ "$D_LINT" = "npm run lint" ] && [ "$D_TEST" = "make test" ] && [ -z "$D_BUILD" ] && ok "discovery: CI configuration (compound and templated lines are skipped)" || die "ci discovery: '$D_BUILD' '$D_TEST' '$D_LINT'"
fx; printf '# x\n\nRun the tests:\n\n    $ cargo test\n' > "$T/fx/README.md"; discover_commands "$T/fx"; [ "$D_TEST" = "cargo test" ] && ok "discovery: README code lines" || die "readme discovery"
# CLI-6: README/CI lines with control operators or redirections are never candidates and never trial-run
fx; printf '# x\n\n    make build & touch PWNED\n    npm test > out.txt\n    npm run lint; touch PWNED\n    cargo test <in\n    pytest `touch PWNED`\n    go test $(touch PWNED)\n    make lint || true\n' > "$T/fx/README.md"
discover_commands "$T/fx"; [ -z "$D_BUILD$D_TEST$D_LINT" ] && ok "discovery: README lines with & ; | < > backticks \$() are rejected" || die "unsafe README lines accepted: '$D_BUILD' '$D_TEST' '$D_LINT'"
D_BUILD='make build & touch PWNED'; D_TEST='npm test > out.txt'; D_LINT=''; verify_commands "$T/fx" >/dev/null
[ ! -e "$T/fx/PWNED" ] && [ ! -e "$T/fx/out.txt" ] && [ -z "$D_BUILD$D_TEST" ] && ok "--verify-commands never runs a command with shell operators" || die "verify_commands ran an unsafe command"
fx; printf '{"scripts":{"test":"jest"}}' > "$T/fx/package.json"; printf '# x\n\n    cargo test\n' > "$T/fx/README.md"
discover_commands "$T/fx"; [ "$D_TEST" = "npm test" ] && ok "discovery: package.json scripts win over README text" || die "README beat package.json: '$D_TEST'"
D_BUILD=true; D_TEST=false; D_LINT=''; : > "$T/fx/x"; verify_commands "$T/fx" >/dev/null
[ "$D_BUILD" = true ] && [ -z "$D_TEST" ] && ok "--verify-commands keeps a command whose trial passes and drops one that fails" || die "verify_commands: '$D_BUILD' '$D_TEST'"
vr=$(mkrepo verify); printf '{"scripts":{"test":"x"}}' > "$vr/package.json"
mkdir -p "$T/stub"; printf '#!/bin/sh\nexit 1\n' > "$T/stub/npm"; chmod +x "$T/stub/npm"
out=$(PATH="$T/stub:$PATH" pl "$vr" init --yes --runtimes claude --verify-commands 2>&1)
expect "init --verify-commands drops a discovered command whose trial failed" "$out" "trial failed"
[ -z "$(cfgv "$vr" commands.test)" ] && ok "...and leaves commands.test empty" || die "failed command still configured"

# ---- terminal installer -------------------------------------------------------------------------------------
inst=$repo/adapters/codex/install.sh
nocheck "install.sh without a terminal and without --yes installs nothing" sh -c "sh '$inst' --dir '$T/h2/bin' </dev/null"
[ ! -e "$T/h2/bin/proofline" ] && ok "...no symlink was created" || die "symlink created without consent"
mkdir -p "$T/h2"; : > "$T/h2/.zshrc"
out=$(HOME=$T/h2 SHELL=/bin/zsh PATH=/usr/bin:/bin sh "$inst" --dir "$T/h2/bin" --yes 2>&1) || { LAST=$out; die "install.sh --yes"; }
[ -L "$T/h2/bin/proofline" ] && [ "$("$T/h2/bin/proofline" version)" = "proofline 0.0.7" ] && ok "install.sh --yes links bin/proofline and the link runs" || die "installed link broken"
expect "install.sh tells the user to run proofline init" "$out" "proofline init"
[ "$(grep -c "$T/h2/bin" "$T/h2/.zshrc")" = 1 ] && ok "install.sh --yes adds the dir to PATH in the rc file once" || die "rc file not updated"
HOME=$T/h2 SHELL=/bin/zsh PATH=/usr/bin:/bin sh "$inst" --dir "$T/h2/bin" --yes >/dev/null 2>&1
[ "$(grep -c "$T/h2/bin" "$T/h2/.zshrc")" = 1 ] && ok "...and a second run does not duplicate it" || die "rc line duplicated"
mkdir -p "$T/h4/bin"; : > "$T/h4/.zshrc"
HOME=$T/h4 SHELL=/bin/zsh PATH="$T/h4/bin:/usr/bin:/bin" sh "$inst" --dir "$T/h4/bin" --yes >/dev/null 2>&1
[ ! -s "$T/h4/.zshrc" ] && ok "install.sh leaves the rc file alone when the dir is already on PATH" || die "rc edited although dir on PATH"

# ---- plugin and skill ---------------------------------------------------------------------------------------
pj=$repo/.claude-plugin/plugin.json; mj=$repo/.claude-plugin/marketplace.json
jqe '.name == "proofline" and .license == "MIT" and .author.name == "Furkan SARIKAYA" and .repository == "https://github.com/furkansarikaya/proofline" and .hooks == "./adapters/claude/hooks/hooks.json"' "$pj" && ok "plugin.json: name, license, author, repository, hooks" || die "plugin.json fields"
jqe '.plugins[0].name == "proofline" and .plugins[0].source == "."' "$mj" && ok "marketplace.json: the repository is its own plugin source" || die "marketplace.json fields"
want=$(ls "$repo/adapters/claude/agents" | sed 's|^|./adapters/claude/agents/|' | sort | tr '\n' ' ')
have=$(jq -r '.agents[]' "$pj" | sort | tr '\n' ' ')
[ "$want" = "$have" ] && ok "plugin.json lists exactly the generated Claude agents" || die "plugin.json agents differ from adapters/claude/agents"
if [ -n "$REAL_CLAUDE" ]; then
  out=$(cd "$repo" && PATH=$(dirname "$REAL_CLAUDE"):$PATH "$REAL_CLAUDE" plugin validate . 2>&1); rc=$?
  [ "$rc" = 0 ] && ok "claude plugin validate . passes" || { LAST=$out; die "claude plugin validate"; }
  out=$(cd "$repo" && "$REAL_CLAUDE" plugin validate . --strict 2>&1); rc=$?
  [ "$rc" = 0 ] && ok "claude plugin validate . --strict passes" || { LAST=$out; die "claude plugin validate --strict"; }
else ok "claude plugin validate skipped (claude is not installed): not tested"; fi
check "the proofline skill carries the shared-rules block verbatim" sh "$repo/tests/shared/check-shared.sh" proofline
grep -q '^name: proofline$' "$repo/skills/proofline/SKILL.md" && grep -q 'ARGUMENTS' "$repo/skills/proofline/SKILL.md" && grep -q 'proofline init' "$repo/skills/proofline/SKILL.md" && ok "the proofline skill routes \$ARGUMENTS and documents the init requirement" || die "proofline skill content"

# ---- insights (A89): read-only cost and recurring-failure report -------------------------------------------
ins=$T/ins
check "insights fixture builds" sh "$repo/fixtures/insights/setup.sh" "$ins"
out=$(pl "$ins" insights 2>&1) || { LAST=$out; die "insights exits 0"; }
ok "insights runs on planted records"
expect "insights: a run with some null tokens shows the sum of the reported ones and how many reported" "$out" "6000 (2/3)"
expect "insights: no token data at all is n/a, not zero" "$out" "RUN-C                  open               n/a     1 n/a              n/a              n/a"
expect "insights: totals sum only recorded tokens" "$out" "tokens in 8000 (3/7), tokens out 1300 (3/7), tokens total 13300 (4/7)"
reject "insights: a record of another schema version is not read" "$out" "999999"
expect "insights: the same finding on shifted lines across rounds and runs is one pattern (x3)" "$out" "repeated-finding x3: REVIEW_RULES src/a.go: Error from Close is ignored"
reject "insights: a different finding with similar text is not merged in" "$out" "Error from Open is ignored"
expect "insights: repeated gate FAILs by gate" "$out" "gate-fail x3: REVIEW_RULES"
expect "insights: repeated UNSUPPORTED checks" "$out" "unsupported x2:"
expect "insights: approvals asked more often than granted" "$out" "approval x2: plan"
expect "insights: every pattern carries a suggestion" "$out" "suggestion:"
check "insights fixture selfcheck (known answers, files unchanged)" sh "$repo/fixtures/insights/selfcheck.sh" "$ins"
out=$(pl "$ins" insights --json 2>&1); LAST=$out
printf '%s' "$out" | jq -e '.schema == "proofline.insights/1"' >/dev/null 2>&1 && ok "insights --json is valid JSON" || die "insights --json is not valid JSON"
printf '%s' "$out" | jq -e '(.runs[] | select(.run == "RUN-C") | .tokens_in) == null and .totals.tokens_in == 8000 and .totals.tokens_in_reported == 3 and .totals.tokens_total == 13300 and .totals.tokens_total_reported == 4 and .metrics.duplicate_run_records == 1 and .metrics.skipped_non_json == 1 and ([.patterns[] | select(.kind == "repeated-finding")] | length == 1)' >/dev/null 2>&1 \
  && ok "insights --json: null tokens stay null, totals and one repeated-finding pattern" || die "insights --json content"
out=$(pl "$ins" insights --run RUN-B 2>&1)
expect "insights --run limits the report to one run" "$out" "RUN-B"
reject "insights --run: other runs are not listed" "$out" "RUN-A"
nocheck "insights --run of an unknown run fails" pl "$ins" insights --run NOPE-9
nocheck "insights --run with a path-like id is refused" pl "$ins" insights --run ../x
nocheck "insights with an unknown argument fails" pl "$ins" insights --frobnicate
before=$(sig "$ins")
chmod -R a-w "$ins/.agents"
if [ "$(id -u)" != 0 ]; then
  out=$(pl "$ins" insights --json 2>&1) && printf '%s' "$out" | jq -e .patterns >/dev/null 2>&1 && ok "insights works on a read-only checkout" || { LAST=$out; die "insights on a read-only checkout"; }
else ok "read-only checkout case skipped (running as root): not tested"; fi
chmod -R u+w "$ins/.agents"
[ "$before" = "$(sig "$ins")" ] && ok "insights leaves every file byte-identical (rules, skills, config, ledger, metrics)" || die "insights changed a file"
noruns=$(mkrepo noruns); mkdir -p "$noruns/.agents/scripts"; printf 'metrics: off\n' > "$noruns/.agents/config.yaml"; : > "$noruns/.agents/scripts/agent.sh"
out=$(pl "$noruns" insights 2>&1) || { LAST=$out; die "insights with no runs and metrics off exits 0"; }
expect "insights with metrics off says no metrics recorded" "$out" "no metrics recorded (metrics: off)"
expect "insights with no runs says so" "$out" "no runs and no metrics to report"
expect "insights with no data finds no recurring failure" "$out" "none found"
out=$(pl "$noruns" insights --json 2>&1); printf '%s' "$out" | jq -e '.metrics.off == true and .runs == [] and .patterns == []' >/dev/null 2>&1 && ok "insights --json with no data is empty and valid" || { LAST=$out; die "insights --json empty"; }
out=$(sh "$PL" help); expect "help lists insights" "$out" "insights [--run ID] [--json]"

# ---- help and the entry skill list the same session commands (A144) --------------------------------------------
# skill: the first cell of the routing row that starts with `run <TASK>`; help: the "agent session" section plus
# resume and deliver, which help lists under "state".
sk_list=$(grep '^| `run <TASK>`' "$repo/skills/proofline/SKILL.md" | sed 's/^| //; s/` | .*//; s/\\|/|/g; s/^`//; s/`, `/@@/g' | tr -s '@' '\n' | sort)
hp_all=$(sh "$PL" help)
hp_list=$(printf '%s\n' "$hp_all" | awk '/^agent session/ { on = 1; next } on && /^  [a-z]/ { print } /^  (resume|deliver)/ { print }' | sed 's/^  //; s/  .*//; s/ | /@@/g' | tr -s '@' '\n' | sort)
[ -n "$sk_list" ] && [ -n "$hp_list" ] || die "help and skill command lists are empty"
if [ "$sk_list" = "$hp_list" ]; then ok "help lists exactly the session commands of the entry skill"
else LAST=$(printf 'skill:\n%s\nhelp:\n%s\n' "$sk_list" "$hp_list"); die "help and skills/proofline/SKILL.md list different session commands"; fi
expect "help lists docs, explain and wiki" "$hp_all" "wiki ingest|query|lint"
expect "help shows init --role" "$hp_all" "--role ROLE=RUNTIME (repeatable)"

# ---- init --role ROLE=RUNTIME (A144) -----------------------------------------------------------------------------
rl=$(mkrepo role1)
pl "$rl" init --yes --runtimes claude,codex --role implementer=codex >/dev/null 2>&1 && ok "init --role implementer=codex is accepted" || die "init --role accepted"
[ "$(cfgv "$rl" runtime.roles.implementer)" = codex ] && ok "the role override is in the config and agent.sh reads it" || die "runtime.roles.implementer not read"
[ "$(cd "$rl" && sh .agents/scripts/exec-policy.sh runtime implementer)" = codex ] && ok "exec-policy resolves the overridden role to codex" || die "exec-policy runtime implementer"
[ "$(cd "$rl" && sh .agents/scripts/exec-policy.sh runtime reviewer)" = claude ] && ok "other roles keep their group runtime" || die "exec-policy runtime reviewer"
out=$(pl "$rl" doctor 2>&1); reject "doctor does not fail the config check with runtime.roles set" "$out" "FAIL config"
rl2=$(mkrepo role2)
pl "$rl2" init --yes --runtimes claude,codex --role implementer=codex --role qa=claude --role implementer=claude >/dev/null 2>&1 && ok "init --role is repeatable" || die "init --role repeated"
[ "$(cfgv "$rl2" runtime.roles.qa)" = claude ] && [ "$(cfgv "$rl2" runtime.roles.implementer)" = claude ] && ok "repeated roles are all written, the last value of a role wins" || die "repeated roles content"
[ "$(grep -c '^    implementer:' "$rl2/.agents/config.yaml")" = 1 ] && ok "a role appears once in the config" || die "duplicate implementer key"
rl3=$(mkrepo role3)
pl "$rl3" init --yes --runtimes claude,codex >/dev/null 2>&1 && sed '/^  roles:/d' "$rl3/.agents/config.yaml" > "$T/cfg-noroles" && cat "$T/cfg-noroles" > "$rl3/.agents/config.yaml" || die "setup of a config without runtime.roles"
pl "$rl3" init --yes --runtimes claude,codex --role qa=codex >/dev/null 2>&1 && [ "$(cfgv "$rl3" runtime.roles.qa)" = codex ] && ok "init --role adds runtime.roles to an older config that lacks it" || die "init --role on a config without runtime.roles"
nocheck "init --role with an empty value is rejected" pl "$(mkrepo rolebad0)" init --yes --role ""
rl4=$(mkrepo role4)
pl "$rl4" init --yes --runtimes claude,codex >/dev/null 2>&1 && sed 's/^  roles:.*/  roles: {}/' "$rl4/.agents/config.yaml" > "$T/cfg-braces" && cat "$T/cfg-braces" > "$rl4/.agents/config.yaml" || die "setup of a config with roles: {}"
pl "$rl4" init --yes --runtimes claude,codex --role qa=codex >/dev/null 2>&1 && [ "$(cfgv "$rl4" runtime.roles.qa)" = codex ] && ! grep -q 'roles: {}' "$rl4/.agents/config.yaml" && ok "a hand-edited roles: {} becomes a proper parent line" || die "init --role on roles: {}"
sed 's/^  roles:.*/  roles: {qa: claude}/' "$rl4/.agents/config.yaml" > "$T/cfg-inline" && cat "$T/cfg-inline" > "$rl4/.agents/config.yaml"
out=$(pl "$rl4" init --yes --runtimes claude,codex --role qa=codex 2>&1) && die "init --role on an inline roles map must fail"
expect "an inline roles value is refused with a clear message" "$out" "has an inline value"
for bad in "nonesuch=codex" "implementer=gemini" "implementer" "implementer=" "=codex" "../x=codex"; do
  rb=$(mkrepo "rolebad$n")
  nocheck "init --role $bad is rejected" pl "$rb" init --yes --role "$bad"
  [ ! -e "$rb/.agents" ] && ok "nothing is written after the rejected --role $bad" || die "files written after --role $bad"
done
out=$(pl "$(mkrepo rolebad2)" init --yes --role nonesuch=codex 2>&1); expect "an unknown role is named in the message" "$out" "unknown role in --role: nonesuch"
out=$(pl "$(mkrepo rolebad3)" init --yes --role implementer=gemini 2>&1); expect "an unknown runtime is named in the message" "$out" "unknown runtime in --role: gemini"
out=$(pl "$(mkrepo rolebad4)" init --yes --role implementer 2>&1); expect "a value without = is named in the message" "$out" "invalid --role value: implementer"
out=$(pl "$(mkrepo rolebad5)" init --yes --runtimes claude --role implementer=codex 2>&1); expect "a runtime outside --runtimes is refused" "$out" "not in --runtimes"

# ---- static analysis ----------------------------------------------------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  out=$(cd "$repo" && shellcheck -s sh -x bin/proofline bin/lib/*.sh adapters/codex/install.sh tests/cli/cli-test.sh 2>&1) && ok "shellcheck -s sh: bin/, installer and this suite are clean" || { LAST=$out; die "shellcheck"; }
else ok "shellcheck skipped (not installed): not tested"; fi
printf 'cli-test: %s checks passed\n' "$n"
