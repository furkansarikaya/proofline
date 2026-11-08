// Proves the planted facts of the api-design fixture built in <dir>. usage: node selfcheck.mjs <built-dir>
import { readdirSync } from 'node:fs';
import { enter, fail, has, nodeOk } from '../selfcheck-lib.mjs';

enter();
if (!nodeOk(['--test', 'test/projects.test.js'])) fail('suite must pass');
if (!has('openapi.yaml', /^openapi: 3.1.0/)) fail('openapi.yaml missing');
if (!has('openapi.yaml', 'required: [name]')) fail('ProjectInput does not require name');
if (!has('openapi.yaml', 'required: [id, name, createdAt]')) fail('Project does not require name');
if (has('openapi.yaml', /^        description:/)) fail('a description property already exists');
if (!has('clients/web/projects.js', /project.name/)) fail('web client does not read name');
if (!has('src/api/projects.js', /body.name/)) fail('handler does not read name');
if (!has('openapi.yaml', 'url: https://api.example.invalid/v1')) fail('v1 server url missing');
if (readdirSync('.', { recursive: true }).some((n) => !String(n).split(/[\\/]/).includes('.git') && /^api\.md$/i.test(String(n).split(/[\\/]/).pop() ?? ''))) fail('an API.md exists');
console.log('selfcheck: api-design ok');
