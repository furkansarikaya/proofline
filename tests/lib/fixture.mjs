// @ts-check
// The helpers of the fixture builders (issue #176, package B): the Node form of what the shell builders did with `mkdir -p`, `cat > f <<'EOF'`,
// `cp`, `chmod` and a `git` with a fixed identity and fixed dates. A builder is `fixtures/<name>/setup.mjs`: it exports `build(target, ...args)`
// and, run directly, is a tiny CLI (`node fixtures/<name>/setup.mjs <target-dir> [args]`, exit 2 on a wrong call, 1 on a non-empty target).
// Every path a builder writes is joined under the target by `Fx.p`, which refuses a path that leaves the target (no `..`, no absolute path).
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The identity and configuration every fixture git command runs with: no user, system or global configuration, a fixed author. */
export const GIT_ENV = {
  GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

export class Fx {
  /** @param {string} root the (existing or creatable) target directory @param {Record<string, string>} [env] overrides of GIT_ENV, e.g. a lower-case identity */
  constructor(root, env = {}) {
    mkdirSync(root, { recursive: true });
    this.root = root;
    this.env = { ...GIT_ENV, ...env };
  }

  /** The absolute path of a repository-relative path; one that would leave the target is refused. @param {string} rel */
  p(rel) {
    const full = path.resolve(this.root, rel);
    const back = path.relative(this.root, full);
    if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) throw new Error(`fixture path leaves the target: ${rel}`);
    return full;
  }

  /** mkdir -p @param {...string} dirs */
  mkdir(...dirs) { for (const d of dirs) mkdirSync(this.p(d), { recursive: true }); }

  /** Write a file (parents created), optional mode (chmod). `cat > f` @param {string} rel @param {string | Buffer} content @param {number} [mode] */
  w(rel, content, mode) {
    const f = this.p(rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, content);
    if (mode !== undefined) chmodSync(f, mode);
  }

  /** `cat >> f` @param {string} rel @param {string} content */
  append(rel, content) { const f = this.p(rel); writeFileSync(f, (existsSync(f) ? readFileSync(f) : '') + content); }

  /** @param {string} rel @returns {string} */
  read(rel) { return readFileSync(this.p(rel), 'utf8'); }

  /** cp (a file or a tree) from an absolute source into the target. @param {string} from @param {string} rel */
  cp(from, rel) { const to = this.p(rel); mkdirSync(path.dirname(to), { recursive: true }); cpSync(from, to, { recursive: true }); }

  /** @param {string} from @param {string} to */
  mv(from, to) { const t = this.p(to); mkdirSync(path.dirname(t), { recursive: true }); renameSync(this.p(from), t); }

  /** rm -rf @param {...string} rels */
  rm(...rels) { for (const r of rels) rmSync(this.p(r), { recursive: true, force: true }); }

  /** chmod @param {string} rel @param {number} mode */
  chmod(rel, mode) { chmodSync(this.p(rel), mode); }

  /** Run git in the target (or a subdirectory) with the fixed environment; throws on a non-zero exit. Returns stdout.
   *  @param {string[]} args @param {{ env?: Record<string, string>, cwd?: string, input?: string, allowFail?: boolean }} [o] */
  git(args, o = {}) {
    const r = spawnSync('git', args, { cwd: o.cwd ? this.p(o.cwd) : this.root, env: { ...process.env, ...this.env, ...o.env }, encoding: 'utf8', input: o.input });
    if (r.status !== 0 && !o.allowFail) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
    return r.stdout ?? '';
  }

  /** `git init -q; git symbolic-ref HEAD refs/heads/main` and the usual local configuration. @param {{ config?: string[][] }} [o] */
  init(o = {}) {
    this.git(['init', '-q']); this.git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    for (const [k, v] of o.config ?? []) this.git(['config', k, v]);
  }

  /** `git add -A; git commit -q -F -` at a fixed date: the message text is read from stdin as the shell fixtures did. @param {string} date @param {string} message */
  commitMsg(date, message) {
    this.git(['add', '-A']);
    this.git(['commit', '-q', '-F', '-'], { input: message, env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  }

  /** `git add -A; git commit -q -m MSG` at a fixed date. @param {string} message @param {string} [date] */
  commit(message, date) {
    this.git(['add', '-A']);
    this.git(['commit', '-q', '-m', message], date ? { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } } : {});
  }
}

/** The non-empty target refusal every builder had. @param {string} target @returns {boolean} true when the target is absent or empty */
export function targetFree(target) {
  return !existsSync(target) || readdirSync(target).length === 0;
}

/** Realpath of a directory that exists. */
export const real = (/** @type {string} */ d) => realpathSync(d);

/**
 * Run a builder as a CLI when its file is the entry point. `usage` is the text after "usage: " (exit 2 when the argument count is wrong:
 * `argc` arguments, or a range [min, max]); a non-empty target is refused with exit 1 (`empty: false` skips that check).
 * @param {string} metaUrl import.meta.url of the builder
 * @param {(target: string, ...rest: string[]) => void | Promise<void>} build
 * @param {{ usage: string, argc?: number | [number, number], targetIndex?: number, empty?: boolean, ok?: (args: string[]) => boolean }} o
 */
export async function cli(metaUrl, build, o) {
  if (!process.argv[1] || metaUrl !== pathToFileURL(process.argv[1]).href) return;
  const args = process.argv.slice(2);
  const [min, max] = Array.isArray(o.argc) ? o.argc : [o.argc ?? 1, o.argc ?? 1];
  if (args.length < min || args.length > max || (o.ok && !o.ok(args))) { console.error(`usage: ${o.usage}`); process.exit(2); }
  const t = args[o.targetIndex ?? 0];
  if (o.empty !== false && !targetFree(t)) { console.error(`error: target directory is not empty: ${t}`); process.exit(1); }
  try { await build(...[t, ...args.filter((_, i) => i !== (o.targetIndex ?? 0))]); } catch (e) { console.error(`error: ${e instanceof Error ? e.message : e}`); process.exit(1); }
}

// ---- selfcheck helpers ------------------------------------------------------------------------------------------------------------------
/** The repository root (fixtures/<name>/selfcheck.mjs and tests/lib are two levels below it). */
export const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/** A selfcheck failure: `selfcheck: <message>` on stderr, exit 1 (the shell selfchecks' `fail`). @param {string} msg @returns {never} */
export function fail(msg) { console.error(`selfcheck: ${msg}`); process.exit(1); }

/** Run a command (argument array, no shell). @param {string} cmd @param {string[]} args @param {import('node:child_process').SpawnSyncOptionsWithStringEncoding} [o]
 *  @returns {{ status: number | null, out: string, err: string, text: string }} */
export function run(cmd, args, o = /** @type {any} */ ({})) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...o });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '', text: (r.stdout ?? '') + (r.stderr ?? '') };
}
