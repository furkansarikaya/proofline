#!/bin/sh
# Builds the ui-design fixture repository in $1: a design system (DESIGN.md,
# tokens, components) and a project list page without filtering.
# Deterministic and offline.
set -eu
[ $# -eq 1 ] || { echo "usage: sh setup.sh <target-dir>" >&2; exit 2; }
if [ -e "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; then
  echo "error: target directory is not empty: $1" >&2; exit 1
fi
mkdir -p "$1"
cd "$1"
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
git init -q
git symbolic-ref HEAD refs/heads/main
git config commit.gpgsign false
git config core.autocrlf false
printf '.agents/\n' >> .git/info/exclude

N=0
commit() {
  N=$((N + 1))
  d="@$((1767261600 + N * 86400)) +0000"
  git add -A
  GIT_AUTHOR_DATE=$d GIT_COMMITTER_DATE=$d git commit -q -m "$1"
}

mkdir -p src/ui/components src/ui/pages src/ui/styles test
cat > package.json <<'X'
{
  "name": "projects-ui-fixture",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
X
cat > src/ui/styles/tokens.css <<'X'
:root {
  --color-text: #1f2328;
  --color-text-muted: #59636e;
  --color-primary: #0969da;
  --color-danger: #cf222e;
  --color-border: #d1d9e0;
  --color-surface: #ffffff;
  --color-surface-muted: #f6f8fa;
  --color-focus: #0969da;
  --color-brand-legacy: #6f42c1; /* deprecated */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 16px;
  --space-4: 24px;
  --radius-md: 6px;
  --font-size-sm: 12px;
  --font-size-md: 14px;
}
X
cat > DESIGN.md <<'X'
# Design system

Tokens are CSS custom properties in `src/ui/styles/tokens.css`. Components are plain DOM functions in
`src/ui/components/` that return an element.

## Tokens

| Token | Use |
|---|---|
| `--color-text`, `--color-text-muted` | body text, secondary text |
| `--color-primary` | primary actions, links |
| `--color-danger` | errors, destructive actions |
| `--color-border` | input and card borders |
| `--color-surface`, `--color-surface-muted` | backgrounds |
| `--color-focus` | focus ring (2px outline) |
| `--color-brand-legacy` | deprecated: do not use in new screens |
| `--space-1` .. `--space-4` | 4 / 8 / 16 / 24 px spacing |
| `--radius-md` | inputs, buttons, cards |
| `--font-size-sm`, `--font-size-md` | 12 / 14 px |

## Components

| Component | Path | Notes |
|---|---|---|
| Button | `src/ui/components/Button.js` | `variant`: primary, secondary |
| TextInput | `src/ui/components/TextInput.js` | always rendered with a visible `<label>` |
| Select | `src/ui/components/Select.js` | native `<select>` with a visible `<label>` |
| Spinner | `src/ui/components/Spinner.js` | `role="status"`, text for screen readers |
| EmptyState | `src/ui/components/EmptyState.js` | title, message, optional action button |
| Alert | `src/ui/components/Alert.js` | `tone`: info, danger; danger uses `role="alert"` |
| Chip | `src/ui/components/Chip.js` | deprecated: do not use in new screens |

## Rules

- Every interactive element is reachable and operable with the keyboard; focus is visible
  (`--color-focus`).
- Every input has a visible label; icons are never the only label.
X
cat > src/ui/components/Button.js <<'X'
export function Button({ label, variant = 'primary', onClick, doc = document }) {
  const el = doc.createElement('button');
  el.type = 'button';
  el.className = `btn btn-${variant}`;
  el.textContent = label;
  if (onClick) el.addEventListener('click', onClick);
  return el;
}
X
cat > src/ui/components/TextInput.js <<'X'
export function TextInput({ id, label, value = '', onInput, doc = document }) {
  const wrap = doc.createElement('div');
  const lab = doc.createElement('label');
  lab.htmlFor = id;
  lab.textContent = label;
  const input = doc.createElement('input');
  input.id = id;
  input.value = value;
  if (onInput) input.addEventListener('input', (e) => onInput(e.target.value));
  wrap.append(lab, input);
  return wrap;
}
X
cat > src/ui/components/Select.js <<'X'
export function Select({ id, label, options, value, onChange, doc = document }) {
  const wrap = doc.createElement('div');
  const lab = doc.createElement('label');
  lab.htmlFor = id;
  lab.textContent = label;
  const select = doc.createElement('select');
  select.id = id;
  for (const o of options) {
    const opt = doc.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    opt.selected = o.value === value;
    select.append(opt);
  }
  if (onChange) select.addEventListener('change', (e) => onChange(e.target.value));
  wrap.append(lab, select);
  return wrap;
}
X
cat > src/ui/components/Spinner.js <<'X'
export function Spinner({ text = 'Loading', doc = document }) {
  const el = doc.createElement('div');
  el.setAttribute('role', 'status');
  el.className = 'spinner';
  el.textContent = text;
  return el;
}
X
cat > src/ui/components/EmptyState.js <<'X'
import { Button } from './Button.js';

export function EmptyState({ title, message, actionLabel, onAction, doc = document }) {
  const el = doc.createElement('section');
  const h = doc.createElement('h2');
  h.textContent = title;
  const p = doc.createElement('p');
  p.textContent = message;
  el.append(h, p);
  if (actionLabel) el.append(Button({ label: actionLabel, variant: 'secondary', onClick: onAction, doc }));
  return el;
}
X
cat > src/ui/components/Alert.js <<'X'
export function Alert({ tone = 'info', message, doc = document }) {
  const el = doc.createElement('div');
  el.className = `alert alert-${tone}`;
  if (tone === 'danger') el.setAttribute('role', 'alert');
  el.textContent = message;
  return el;
}
X
cat > src/ui/components/Chip.js <<'X'
// Deprecated: do not use in new screens.
export function Chip({ label, doc = document }) {
  const el = doc.createElement('span');
  el.className = 'chip';
  el.style.background = 'var(--color-brand-legacy)';
  el.textContent = label;
  return el;
}
X
cat > src/ui/pages/ProjectList.js <<'X'
import { Spinner } from '../components/Spinner.js';
import { EmptyState } from '../components/EmptyState.js';
import { Alert } from '../components/Alert.js';

// Renders the project list. state: { status: 'loading' | 'error' | 'ready', projects, error }
// projects: [{ id, name, status: 'active' | 'archived' }]
export function ProjectList(state, { doc = document } = {}) {
  const root = doc.createElement('main');
  const h = doc.createElement('h1');
  h.textContent = 'Projects';
  root.append(h);
  if (state.status === 'loading') return root.append(Spinner({ text: 'Loading projects', doc })), root;
  if (state.status === 'error') return root.append(Alert({ tone: 'danger', message: state.error, doc })), root;
  if (state.projects.length === 0) {
    root.append(EmptyState({ title: 'No projects yet', message: 'Create your first project.', doc }));
    return root;
  }
  const list = doc.createElement('ul');
  for (const p of state.projects) {
    const li = doc.createElement('li');
    li.textContent = `${p.name} (${p.status})`;
    list.append(li);
  }
  root.append(list);
  return root;
}
X
cat > test/components.test.js <<'X'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('every component listed in DESIGN.md exists', () => {
  const design = readFileSync(new URL('../DESIGN.md', import.meta.url), 'utf8');
  const paths = [...design.matchAll(/`(src\/ui\/components\/\w+\.js)`/g)].map((m) => m[1]);
  assert.equal(paths.length, 7);
  for (const p of paths) readFileSync(new URL(`../${p}`, import.meta.url));
});
X
commit "feat: design system and project list"
