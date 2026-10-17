#!/bin/sh
# shellcheck disable=SC2015,SC2016 # ok/no chains each print one line; ${...} decoys are literal
# Tests for secret-scan.sh. Fake secrets are assembled at run time from fragments so this repository
# never contains a realistic secret literal.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
ss="$here/secret-scan.sh"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/secret-scan-test.XXXXXX") || { echo "TMPDIR must be an existing directory: ${TMPDIR:-/tmp}" >&2; exit 2; }; trap 'rm -rf "$tmp"' EXIT
fails=0
ok() { echo "PASS $1"; }
no() { echo "FAIL $1"; fails=$((fails + 1)); }
scan() { rc=0; out=$(sh "$ss" --root "$tmp/p" "$@" 2>"$tmp/err") || rc=$?; }
found() { printf '%s\n' "$out" | grep -qx "$1"; }

mkdir -p "$tmp/p/src" "$tmp/p/.git"
up='ABCDEFGHIJKLMNOP' al='q8Zr2Lm9Xc4Vb7Nk1Pw6Ty3Hs5Jd0FgE'
{
  echo "aws_key = '$(printf '%s%s' AKI A)${up}'"
  printf 'gh = "%s%s"\n' 'ghp' "_${al}Ab12"
  printf 'gl = "%s%s"\n' 'glp' "at-${al}"
  printf 'slack = "%s%s"\n' 'xox' "b-1234567890-${al}"
  printf '%s%s\n' '-----BEGIN RSA PRIV' 'ATE KEY-----'
  printf 'jwt = "%s.%s.%s"\n' "eyJ${al}" "eyJ${al}" "${al}"
  printf 'db_password = "%s"\n' "Xk9${al}"
  printf 'token = "%s"   # proofline:allow-secret\n' "Zz8${al}"
} > "$tmp/p/src/app.py"
{
  echo 'password = "changeme-changeme-changeme"'
  echo 'api_key = "${API_KEY_FROM_ENV_VARIABLE}"'
  echo 'token = "aaaaaaaaaaaaaaaaaaaa1"'
  echo 'description = "a long harmless string value 12345"'
  echo 'aws = "AKIAEXAMPLE"'
} > "$tmp/p/src/decoys.py"
printf 'DB_HOST=localhost\n' > "$tmp/p/.env"
printf 'DB_HOST=\n' > "$tmp/p/.env.example"
printf 'GH=%s%s\n' 'ghp' "_${al}Ab12" > "$tmp/p/.git/config"

scan src/app.py
for r in 1:aws_access_key_id 2:github_token 3:gitlab_token 4:slack_token 5:private_key 6:jwt 7:generic_secret; do
  if found "src/app.py:${r%%:*}:${r#*:}"; then ok "detects ${r#*:}"; else no "detects ${r#*:} (got: $out)"; fi
done
[ "$rc" -eq 1 ] && ok "exit 1 when secrets are found" || no "exit 1 when secrets are found ($rc)"
printf '%s\n' "$out" | grep -q '^src/app.py:8:' && no "allowlist comment suppresses a line" || ok "allowlist comment suppresses a line"
case "$out" in *"$al"*|*ABCDEFGH*) no "never prints secret values" ;; *) ok "never prints secret values" ;; esac

scan src/decoys.py
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "decoys are not reported" || no "decoys are not reported ($out)"
scan .
found ".env:1:env_file" && ok ".env with a value is reported" || no ".env with a value is reported"
printf '%s\n' "$out" | grep -q 'env.example\|\.git/' && no ".env.example and .git are skipped" || ok ".env.example and .git are skipped"
scan missing.txt
[ "$rc" -eq 2 ] && ok "missing path is an error" || no "missing path is an error ($rc)"

mkdir -p "$tmp/p/.agents"
printf 'commands:\n  secret_scan: ! grep -q LEAK  # project tool\n' > "$tmp/p/.agents/config.yaml"
scan src/decoys.py
[ "$rc" -eq 0 ] && ok "commands.secret_scan decides: clean" || no "commands.secret_scan decides: clean ($rc)"
echo LEAK > "$tmp/p/src/x.txt"; scan src/x.txt
[ "$rc" -eq 1 ] && ok "commands.secret_scan decides: found" || no "commands.secret_scan decides: found ($rc)"
echo 'exit 3' > "$tmp/tool.sh"; printf 'commands:\n  secret_scan: sh %s\n' "$tmp/tool.sh" > "$tmp/p/.agents/config.yaml"; scan src/x.txt
[ "$rc" -eq 2 ] && ok "commands.secret_scan failure is an error" || no "commands.secret_scan failure is an error ($rc)"

[ "$fails" -eq 0 ]
