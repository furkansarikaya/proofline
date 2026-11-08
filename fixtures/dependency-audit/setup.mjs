// Builds the dependency-audit fixture repository in <target-dir> (A88; must be empty or absent).
// A tiny npm project. `main` is the base commit; branch `feature/dep-update` carries a change with planted
// dependency facts (undeclared dependency, install hook, license policy hit, flagged-but-declared
// dependencies, lockfile-only decoys); branch `feature/dep-ok` carries a clean, fully declared change.
// The run folder (.agents/runs/DA-1/) holds one PLAN-*.md per branch and `.agents/config.yaml` the license
// policy; both are git-ignored. Deterministic (fixed identity and dates), offline, installs nothing.
import { Fx, cli } from '../../tests/lib/fixture.mjs';

/** @param {string} target */
export function build(target) {
  const f = new Fx(target);
  f.init();
  f.w('.gitignore', '.agents/\n');
  f.mkdir(`src`, `scripts`, `.agents/runs/DA-1`);
f.w(`src/index.js`, `export const total = (items) => items.reduce((n, i) => n + i.price, 0);
`);
  f.w('scripts/setup.js', 'console.log("setup");\n');
  // --- base ------------------------------------------------------------------------------------------
f.w(`package.json`, `{
  "name": "billing-app",
  "version": "1.0.0",
  "private": true,
  "scripts": { "test": "node --test" },
  "dependencies": { "date-utils": "^2.1.0", "http-kit": "3.0.0" },
  "devDependencies": { "test-helper": "1.2.0" }
}
`);
f.w(`package-lock.json`, `{
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
`);
f.w(`pyproject.toml`, `[project]
name = "billing-tools"
dependencies = [
  "requests>=2.0",
]
`);
f.w(`Cargo.toml`, `[package]
name = "billing-core"
version = "0.1.0"

[dependencies]
serde = "1"
`);
f.w(`build.gradle`, `dependencies {
    implementation 'org.acme:base-lib:1.0'
}
`);
  f.mkdir(`deps`);
  f.w('requirements.txt', 'requests==2.0\n');
  f.w('deps/extra.pip', 'safe-lib==1.0\n');
  f.commit('billing: initial', '2026-01-01T10:00:00Z');
  // --- license policy (config) and plans ------------------------------------------------------------
f.w(`.agents/config.yaml`, `canonical_branch: main
security:
  licenses:
    allow:
    deny: GPL-3.0-only AGPL-3.0-only
`);
f.w(`.agents/runs/DA-1/PLAN-fail.md`, `# Plan: DA-1

## Dependencies

- uuid-lite: id generation for orders
- git-tool: pinned fork of the export tool, tag v1.2.0
- fmt-lite: number formatting helper
- copyleft-lib: report export
- date-utils: bump to ^2.2.0 for the time zone fix
- foo: http client wrapper (python tools)
- unixcrate: unix sockets (rust core)
- org.acme:bom: bill of materials (jvm)
`);
f.w(`.agents/runs/DA-1/PLAN-ok.md`, `# Plan: DA-1

## Dependencies

- uuid-lite: id generation for orders
- date-utils: bump to ^2.2.0 for the time zone fix
`);
  // --- feature/dep-update: planted facts ---------------------------------------------------------
  f.git(['checkout', '-q', '-b', 'feature/dep-update']);
f.w(`package.json`, `{
  "name": "billing-app",
  "version": "1.0.0",
  "private": true,
  "scripts": { "test": "node --test", "postinstall": "node scripts/setup.js" },
  "dependencies": {
    "al": "npm:evilnpm@1.0.0",
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
`);
f.w(`package-lock.json`, `{
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
`);
  // the other ecosystems: constructs a shallow reader would miss (extras containing ], table-form crates,
  // platform() and map notation)
f.w(`pyproject.toml`, `[project]
name = "billing-tools"
dependencies = [
  "foo[bar]>=1.0",
  "requests>=2.0",
  "evilpy==1.0",
]
`);
f.w(`Cargo.toml`, `[package]
name = "billing-core"
version = "0.1.0"

[dependencies]
serde = "1"
renamed = { package = "evil-crate", version = "1" }

[dependencies.evilcrate]
version = "0.3"

[target.'cfg(unix)'.dependencies.unixcrate]
version = "1.1"
`);
f.w(`build.gradle`, `dependencies {
    implementation 'org.acme:base-lib:1.0'
    implementation platform("org.acme:bom:1.0")
    implementation group: 'org.evil', name: 'lib', version: '1.2'
}
`);
  // requirements: an include of a file with any name, a non-default index (the default one is not a finding)
f.w(`requirements.txt`, `requests==2.0
-r deps/extra.pip
--index-url https://pypi.org/simple
--extra-index-url https://pkgs.evil.example/simple
markerpkg>=1.0;python_version<"3.9"
nested[a[b]]==2.0
`);
f.w(`deps/extra.pip`, `safe-lib==1.0
evilreq==1.0
`);
  f.commit('billing: dependency update', '2026-01-02T10:00:00Z');
  // --- feature/dep-ok: everything declared -------------------------------------------------------
  f.git(['checkout', '-q', '-b', 'feature/dep-ok', 'main']);
f.w(`package.json`, `{
  "name": "billing-app",
  "version": "1.0.0",
  "private": true,
  "scripts": { "test": "node --test" },
  "dependencies": { "date-utils": "^2.2.0", "http-kit": "3.0.0", "uuid-lite": "2.0.0" },
  "devDependencies": { "test-helper": "1.2.0" }
}
`);
f.w(`package-lock.json`, `{
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
`);
  f.commit('billing: add uuid-lite', '2026-01-02T11:00:00Z');
  f.git(['checkout', '-q', 'feature/dep-update']);
  console.log(`fixture built in ${target} (branches: feature/dep-update, feature/dep-ok)`);

}

await cli(import.meta.url, build, { usage: 'node setup.mjs <target-dir>' });
