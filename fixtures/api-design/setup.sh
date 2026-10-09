#!/bin/sh
# Builds the api-design fixture repository in $1: a projects API whose
# contract lives in openapi.yaml, with a web client that reads `name`.
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

mkdir -p src/api clients/web test
cat > package.json <<'X'
{
  "name": "projects-api-fixture",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
X
cat > README.md <<'X'
# projects-api

The HTTP contract is `openapi.yaml` (OpenAPI 3.1); it is the source of truth for clients.
Public consumers: our web app (`clients/web/`) and partner integrations using API version 1.
X
cat > openapi.yaml <<'X'
openapi: 3.1.0
info:
  title: Projects API
  version: 1.4.0
servers:
  - url: https://api.example.invalid/v1
paths:
  /projects:
    get:
      operationId: listProjects
      responses:
        '200':
          description: All projects.
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Project'
    post:
      operationId: createProject
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ProjectInput'
      responses:
        '201':
          description: Created.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Project'
        '400':
          description: Invalid input.
  /projects/{id}:
    get:
      operationId: getProject
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: integer
      responses:
        '200':
          description: One project.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Project'
        '404':
          description: Not found.
components:
  schemas:
    ProjectInput:
      type: object
      required: [name]
      properties:
        name:
          type: string
          minLength: 1
          maxLength: 100
    Project:
      type: object
      required: [id, name, createdAt]
      properties:
        id:
          type: integer
        name:
          type: string
        createdAt:
          type: string
          format: date-time
X
cat > src/api/projects.js <<'X'
// Handlers for the operations in openapi.yaml.
const projects = [];

export function createProject(body, now = new Date()) {
  if (typeof body?.name !== 'string' || body.name.length < 1 || body.name.length > 100) {
    return { status: 400 };
  }
  const project = { id: projects.length + 1, name: body.name, createdAt: now.toISOString() };
  projects.push(project);
  return { status: 201, body: project };
}

export function listProjects() {
  return { status: 200, body: projects };
}

export function getProject(id) {
  const project = projects.find((p) => p.id === id);
  return project ? { status: 200, body: project } : { status: 404 };
}
X
cat > clients/web/projects.js <<'X'
// Web client view model.
export function projectLabel(project) {
  return `${project.name} (#${project.id})`;
}
X
cat > test/projects.test.js <<'X'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, getProject } from '../src/api/projects.js';

test('creates and reads a project', () => {
  const created = createProject({ name: 'Alpha' }, new Date('2026-01-01T00:00:00Z'));
  assert.equal(created.status, 201);
  assert.equal(getProject(created.body.id).body.name, 'Alpha');
  assert.equal(createProject({ name: '' }).status, 400);
});
X
commit "feat: projects API v1.4"
