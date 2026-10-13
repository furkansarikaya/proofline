#!/bin/sh
# Builds the dependency-audit fixture repository in $1 (A88; must be empty or absent).
# A tiny npm project. `main` is the base commit; branch `feature/dep-update` carries a change with planted
# dependency facts (undeclared dependency, install hook, license policy hit, flagged-but-declared
# dependencies, lockfile-only decoys); branch `feature/dep-ok` carries a clean, fully declared change.
# The run folder (.agents/runs/DA-1/) holds one PLAN-*.md per branch and `.agents/config.yaml` the license
# policy; both are git-ignored. Deterministic (fixed identity and dates), offline, installs nothing.
set -eu

[ $# -eq 1 ] || { echo "usage: sh setup.sh <target-dir>" >&2; exit 2; }
TARGET=$1
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "error: target directory is not empty: $TARGET" >&2
  exit 1
fi
mkdir -p "$TARGET"
cd "$TARGET"

GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_NOSYSTEM=1
GIT_AUTHOR_NAME=Fixture
GIT_AUTHOR_EMAIL=fixture@example.invalid
GIT_COMMITTER_NAME=Fixture
GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
commit() { GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -q -m "$2"; }

git init -q
git symbolic-ref HEAD refs/heads/main
printf '.agents/\n' > .gitignore
mkdir -p src scripts .agents/runs/DA-1

cat > src/index.js <<'EOF'
export const total = (items) => items.reduce((n, i) => n + i.price, 0);
EOF
printf 'console.log("setup");\n' > scripts/setup.js

# --- base ------------------------------------------------------------------------------------------
cat > package.json <<'EOF'
{
  "name": "billing-app",
  "version": "1.0.0",
  "private": true,
  "scripts": { "test": "node --test" },
  "dependencies": { "date-utils": "^2.1.0", "http-kit": "3.0.0" },
  "devDependencies": { "test-helper": "1.2.0" }
}
EOF
cat > package-lock.json <<'EOF'
{
  "name": "billing-app",
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "billing-app", "version": "1.0.0" },
    "node_modules/date-utils": { "version": "2.1.4", "license": "MIT" },
    "node_modules/http-kit": { "version": "3.0.0", "license": "MIT" },
    "node_modules/ms": { "version": "2.1.2", "license": "MIT" },
    "node_modules/test-helper": { "version": "1.2.0", "license": "MIT", "dev": true }
  }
}
EOF
git add -A
commit 2026-01-01T10:00:00Z "billing: initial"

# --- license policy (config) and plans ------------------------------------------------------------
cat > .agents/config.yaml <<'EOF'
canonical_branch: main
security:
  licenses:
    allow:
    deny: GPL-3.0-only AGPL-3.0-only
EOF
cat > .agents/runs/DA-1/PLAN-fail.md <<'EOF'
# Plan: DA-1

## Dependencies

- uuid-lite: id generation for orders
- git-tool: pinned fork of the export tool, tag v1.2.0
- fmt-lite: number formatting helper
- copyleft-lib: report export
- date-utils: bump to ^2.2.0 for the time zone fix
EOF
cat > .agents/runs/DA-1/PLAN-ok.md <<'EOF'
# Plan: DA-1

## Dependencies

- uuid-lite: id generation for orders
- date-utils: bump to ^2.2.0 for the time zone fix
EOF

# --- feature/dep-update: planted facts ---------------------------------------------------------
git checkout -q -b feature/dep-update
cat > package.json <<'EOF'
{
  "name": "billing-app",
  "version": "1.0.0",
  "private": true,
  "scripts": { "test": "node --test", "postinstall": "node scripts/setup.js" },
  "dependencies": {
    "copyleft-lib": "1.0.0",
    "date-utils": "^2.2.0",
    "fmt-lite": "*",
    "git-tool": "git+https://example.invalid/acme/git-tool.git#v1.2.0",
    "http-kit": "3.0.0",
    "quick-json": "^1.4.0",
    "uuid-lite": "2.0.0"
  },
  "devDependencies": { "test-helper": "1.2.0" }
}
EOF
cat > package-lock.json <<'EOF'
{
  "name": "billing-app",
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "billing-app", "version": "1.0.0" },
    "node_modules/copyleft-lib": { "version": "1.0.0", "license": "GPL-3.0-only" },
    "node_modules/date-utils": { "version": "2.2.0", "license": "MIT" },
    "node_modules/fmt-lite": { "version": "0.9.1", "license": "MIT" },
    "node_modules/git-tool": { "version": "1.2.0", "license": "MIT" },
    "node_modules/http-kit": { "version": "3.0.0", "license": "MIT" },
    "node_modules/inner-helper": { "version": "0.3.1", "license": "MIT", "hasInstallScript": true },
    "node_modules/ms": { "version": "2.1.3", "license": "MIT" },
    "node_modules/quick-json": { "version": "1.4.2", "license": "MIT" },
    "node_modules/test-helper": { "version": "1.2.0", "license": "MIT", "dev": true },
    "node_modules/uuid-lite": { "version": "2.0.0", "license": "MIT" }
  }
}
EOF
git add -A
commit 2026-01-02T10:00:00Z "billing: dependency update"

# --- feature/dep-ok: everything declared -------------------------------------------------------
git checkout -q -b feature/dep-ok main
cat > package.json <<'EOF'
{
  "name": "billing-app",
  "version": "1.0.0",
  "private": true,
  "scripts": { "test": "node --test" },
  "dependencies": { "date-utils": "^2.2.0", "http-kit": "3.0.0", "uuid-lite": "2.0.0" },
  "devDependencies": { "test-helper": "1.2.0" }
}
EOF
cat > package-lock.json <<'EOF'
{
  "name": "billing-app",
  "lockfileVersion": 3,
  "packages": {
    "": { "name": "billing-app", "version": "1.0.0" },
    "node_modules/date-utils": { "version": "2.2.0", "license": "MIT" },
    "node_modules/http-kit": { "version": "3.0.0", "license": "MIT" },
    "node_modules/ms": { "version": "2.1.3", "license": "MIT" },
    "node_modules/test-helper": { "version": "1.2.0", "license": "MIT", "dev": true },
    "node_modules/uuid-lite": { "version": "2.0.0", "license": "MIT" }
  }
}
EOF
git add -A
commit 2026-01-02T11:00:00Z "billing: add uuid-lite"

git checkout -q feature/dep-update
echo "fixture built in $TARGET (branches: feature/dep-update, feature/dep-ok)"
