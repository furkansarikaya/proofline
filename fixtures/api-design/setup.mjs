// Builds the api-design fixture repository in <target-dir>: a projects API whose
// contract lives in openapi.yaml, with a web client that reads `name`.
// Deterministic and offline.
import { Fx, cli } from '../../tests/lib/fixture.mjs';

/** @param {string} target */
export function build(target) {
  const f = new Fx(target);
  f.init({ config: [['commit.gpgsign', 'false'], ['core.autocrlf', 'false']] });
  let n = 0;
  /** @param {string} message @param {string} [date] */
  const commit = (message, date) => {
    n++;
    const d = date ?? `@${1767261600 + n * 86400} +0000`;
    f.git(['add', '-A']);
    f.git(['commit', '-q', '-m', message], { env: { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d } });
  };
  f.append('.git/info/exclude', '.agents/\n');

  f.mkdir('src/api', 'clients/web', 'test');
  f.w('package.json', `{
  "name": "projects-api-fixture",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
`);
  f.w('README.md', `# projects-api

The HTTP contract is \`openapi.yaml\` (OpenAPI 3.1); it is the source of truth for clients.
Public consumers: our web app (\`clients/web/\`) and partner integrations using API version 1.
`);
  f.w('openapi.yaml', `openapi: 3.1.0
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
`);
  f.w('src/api/projects.js', `// Handlers for the operations in openapi.yaml.
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
`);
  f.w('clients/web/projects.js', `// Web client view model.
export function projectLabel(project) {
  return \`\${project.name} (#\${project.id})\`;
}
`);
  f.w('test/projects.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, getProject } from '../src/api/projects.js';

test('creates and reads a project', () => {
  const created = createProject({ name: 'Alpha' }, new Date('2026-01-01T00:00:00Z'));
  assert.equal(created.status, 201);
  assert.equal(getProject(created.body.id).body.name, 'Alpha');
  assert.equal(createProject({ name: '' }).status, 400);
});
`);
  commit('feat: projects API v1.4');

}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });

