// @ts-check
// The Codex worker's network and local-server permission (A372, issue 338 U2). A Codex worker runs under the profile `proofline-worker` (codexprofile.mjs,
// dispatcher.mjs `codexProfileArgs`): no outbound network and no loopback listener by default. A project may widen exactly those two things, deliberately, with three keys of
// `.agents/config.yaml`:
//   codex.sandbox.network: off | on        outbound network for the Codex workers of this project (the profile has one switch: no domain list is modelled here)
//   codex.sandbox.local_server: off | on   a loopback listener (a test that starts a local server)
//   codex.sandbox.failover: off | claude   a Codex implementer stopped by the sandbox is handed to the Claude implementer (reason `sandbox_block`, D7/A203)
// Every default is off, and ANYTHING but the exact word `on` (or `claude`) reads as off: the safe side (invariant 6). Nothing in this module writes the config. The file is the
// user's: the runtime hook refuses every agent write to `.agents/config.yaml` and the profile grants a Codex worker `.agents` read only, so only the user can switch a key on
// (invariant 3); `init` and `upgrade` add a missing key with its default `off` and never change a value. A permission set to `on` changes NOTHING else of the profile: no
// filesystem grant is added, no secrets path, no deny dropped (the filesystem argument is byte-equal on and off; a test pins it).
import { roleGroup } from './execpolicy.mjs';

/** @typedef {{ network: boolean, localServer: boolean, failover: boolean, invalid: string[] }} SandboxPermission */

export const SANDBOX_KEYS = /** @type {const} */ (['codex.sandbox.network', 'codex.sandbox.local_server', 'codex.sandbox.failover']);
const ROLES = ['task_author', 'explorer', 'architect', 'data_architect', 'designer', 'qa', 'implementer', 'reviewer', 'security_reviewer', 'verifier'];

/** @param {{ get(key: string, def?: string): string }} cfg @returns {SandboxPermission} */
export function sandboxPermission(cfg) {
  /** @type {string[]} */ const invalid = [];
  const one = (/** @type {string} */ key, /** @type {string} */ yes) => {
    const v = cfg.get(key, '').trim();
    if (v !== '' && v !== 'off' && v !== yes) invalid.push(`${key}: ${v} (want ${yes === 'on' ? 'on|off' : 'claude|off'}; read as off)`);
    return v === yes;
  };
  return { network: one(SANDBOX_KEYS[0], 'on'), localServer: one(SANDBOX_KEYS[1], 'on'), failover: one(SANDBOX_KEYS[2], 'claude'), invalid };
}

/** The one line doctor, the batch summary and the status block show. @param {SandboxPermission} p */
export function permissionLine(p) {
  return `codex network: ${p.network ? 'ON' : 'off'}, local server: ${p.localServer ? 'ON' : 'off'}, failover to the Claude implementer on a sandbox block: ${p.failover ? 'ON' : 'off'}`;
}

/** Is any of the three widened? @param {SandboxPermission} p */
export const anyOn = (p) => p.network || p.localServer || p.failover;

/**
 * The extra `-c` arguments of the Codex profile: none unless a permission is on. They name only the `network` table of the profile, never the `filesystem` one.
 * @param {SandboxPermission} p @returns {string[]}
 */
export function profileNetworkArgs(p) {
  /** @type {string[]} */ const a = [];
  if (p.network) a.push('-c', 'permissions.proofline-worker.network.enabled=true');
  if (p.localServer) a.push('-c', 'permissions.proofline-worker.network.allow_local_binding=true');
  return a;
}

/** The roles of this project that run on Codex. @param {{ get(key: string, def?: string): string }} cfg @returns {string[]} */
export function codexRoles(cfg) {
  return ROLES.filter((r) => (cfg.get(`runtime.roles.${r}`, '') || cfg.get(`runtime.${roleGroup(r)}`, '') || 'claude') === 'codex');
}

const NET = [/\b(curl|wget)\b/, /\b(npm|pnpm|yarn|bun)\s+(install|ci|add|i)\b/, /\bpip3?\s+install\b/, /\bgo\s+(get|mod\s+download)\b/, /\bcargo\s+(fetch|install|add)\b/, /\b(bundle|composer)\s+(install|require)\b/, /\bgit\s+(clone|fetch|pull|ls-remote)\b/, /\bdocker\s+pull\b/];
const LOCAL = [/\b(localhost|127\.0\.0\.1|0\.0\.0\.0)\b/, /\[::1\]/, /\bloopback\b/i, /\.listen\s*\(/, /\bcreateServer\s*\(/, /\bnpm\s+(run\s+)?(start|dev|serve)\b/, /\bhttp\.server\b/];

/**
 * What the plan's commands and tests need that the default profile refuses (a hint from the words of the plan, never a proof; it only makes the warning earlier).
 * @param {string} text @returns {{ network: string[], localServer: string[] }}
 */
export function sandboxNeeds(text) {
  /** @type {string[]} */ const network = []; /** @type {string[]} */ const localServer = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l === '' || l.startsWith('#')) continue;
    if (NET.some((re) => re.test(l))) network.push(l.slice(0, 100));
    if (LOCAL.some((re) => re.test(l))) localServer.push(l.slice(0, 100));
  }
  return { network: network.slice(0, 3), localServer: localServer.slice(0, 3) };
}

/**
 * The warning line before an implementer starts on Codex, or '' when nothing is needed or what is needed is allowed.
 * @param {SandboxPermission} p @param {{ network: string[], localServer: string[] }} needs
 */
export function preflightWarning(p, needs) {
  /** @type {string[]} */ const keys = [];
  if (needs.network.length > 0 && !p.network) keys.push('codex.sandbox.network');
  if (needs.localServer.length > 0 && !p.localServer) keys.push('codex.sandbox.local_server');
  if (keys.length === 0) return '';
  const e = needs.network.length > 0 && !p.network ? needs.network[0] : needs.localServer[0];
  const next = p.failover ? 'if the sandbox stops it, the step is handed to the Claude implementer (codex.sandbox.failover: claude)'
    : 'if the sandbox stops it, it is BLOCKED with the guidance: run this role with --runtime claude, or decide yourself to set codex.sandbox.failover: claude (hand it to the Claude implementer) or the key(s) above in .agents/config.yaml (it lets a Codex worker reach the network or listen on loopback)';
  return `preflight: the plan of this task has commands the Codex sandbox refuses by default (${e}); ${keys.join(' and ')} is off; ${next}`;
}

/**
 * Is the end of a Codex log a sandbox refusal that is not the API connection (that one is `runtime_unavailable:network`)? A loopback listener or bind refused, or an outbound
 * connection or name lookup refused by the sandbox.
 * @param {string[]} tail the last lines of the log
 */
export function sandboxBlockLines(tail) {
  return tail.some((l) => /\b(listen|bind)\b.*\b(EPERM|EACCES|operation not permitted)\b|\b(EPERM|EACCES)\b.*\b(listen|bind)\b|\bsandbox\b.*\b(denied|blocked|refused|not permitted)\b|\b(denied|blocked|refused)\b.*\bby\b.*\bsandbox\b|getaddrinfo (EAI_AGAIN|ENOTFOUND)|Could not resolve host|Network is unreachable/i.test(l));
}
