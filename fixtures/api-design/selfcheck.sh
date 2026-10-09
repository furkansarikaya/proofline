#!/bin/sh
# Proves the planted facts of the api-design fixture built in $1.
set -eu
cd "$1"
fail() { echo "selfcheck: $*" >&2; exit 1; }

node --test test/projects.test.js >/dev/null 2>&1 || fail "suite must pass"
grep -q '^openapi: 3.1.0' openapi.yaml || fail "openapi.yaml missing"
grep -q 'required: \[name\]' openapi.yaml || fail "ProjectInput does not require name"
grep -q 'required: \[id, name, createdAt\]' openapi.yaml || fail "Project does not require name"
grep -q '^        description:' openapi.yaml && fail "a description property already exists"
grep -q 'project.name' clients/web/projects.js || fail "web client does not read name"
grep -q 'body.name' src/api/projects.js || fail "handler does not read name"
grep -q 'url: https://api.example.invalid/v1' openapi.yaml || fail "v1 server url missing"
find . -path ./.git -prune -o -iname 'API.md' -print | grep -q . && fail "an API.md exists"
echo "selfcheck: api-design ok"
