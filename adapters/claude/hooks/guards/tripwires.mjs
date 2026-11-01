// @ts-check
// The Stage 1/2 tripwires (ADR 0001 sections 5.3 and 7): a model Bash command that starts Node on the control plane in a spelling the hook can see,
// or assigns PROOFLINE_ENGINE* / PROOFLINE_TEST*, or sets NODE_OPTIONS with a preload. Tripwires, not the boundary (approve records only from a
// captured user message). Port of tw_core_node, tw_lit and tw_node_operand of proofline-hook.sh.
//   twCoreNode(text)      the text starts Node on the control plane (inline code, stdin code, a script under .agents/scripts, process.execPath)
//   twNodeOperand(text)   a node word whose script operand is not a plain literal path (a variable, substitution, glob, xargs / find -exec / stdin feed ...)
//   PROOFLINE_ASSIGN / NODE_OPTIONS_PRELOAD   the two assignment patterns
import { grepq } from './kit.mjs';

const S = ' \\t\\n\\v\\f\\r';
const ID = 'A-Za-z0-9_.-';

export const PROOFLINE_ASSIGN = new RegExp(`PROOFLINE_(ENGINE|TEST)[A-Za-z0-9_]*[${S}]*[+]?=`);
export const NODE_OPTIONS_PRELOAD = new RegExp(`NODE_OPTIONS[${S}]*[+]?=[^;&|]*(--require|--import|--loader|--experimental-loader)|NODE_OPTIONS[${S}]*[+]?=([^;&|]*[${S}="'])?-r([${S}=./"']|$)`);

const CORE = `(proofline-core([.]mjs|[^${ID}]|$)|[.]agents/scripts)`;
const CORE_RE = new RegExp(CORE);
const NODE_SEG = new RegExp(`(^|[^${ID}])(node|nodejs)([^A-Za-z0-9_-]|$)`);
const NW = `(^|[^${ID}])(node|nodejs)[${S}]+([^;&|]*[${S}])?`;
const SEP = /[;&|(){}]/g;

/** The `tr ';&|(){}' '\n...'` cut, then `grep -E`: the segments (lines) that match. @param {string} text @param {RegExp} re */
function segments(text, re) {
  return text.replace(SEP, '\n').split('\n').filter((l) => re.test(l));
}

const OPTS_RE = new RegExp(`^.*(^|[^${ID}])(node|nodejs)[${S}]+((-[^${S}]*[${S}]+)*).*$`);
const OP_RE = new RegExp(`^.*(^|[^${ID}])(node|nodejs)[${S}]+(-[^${S}]*[${S}]+)*([^-${S}][^${S}]*).*$`);

/** @param {string} line @param {RegExp} re @param {number} g */
function sedGroup(line, re, g) {
  const m = re.exec(line);
  return m ? (m[g] ?? '') : null;
}

/** `tw_core_node TEXT`. @param {string} text */
export function twCoreNode(text) {
  if (!(text.includes('node') || text.includes('execPath') || text.includes('proofline-core'))) return false;
  if (!grepq(CORE_RE, text)) return false;
  const flat = text.replace(/\n/g, ' ');
  if (flat.includes('execPath')) return true;
  if (new RegExp(`${NW}(-[A-Za-z]*[eEpr]|--eval|--print|--require|--import|--loader|--experimental-loader)([${S}=].*)?${CORE}`).test(flat)) return true;
  if (new RegExp(`${NW}(--input-type|-)([${S}=]|$)`).test(flat)) return true;
  // a node segment: the core named anywhere in it, or a script under .agents/scripts as its first operand
  for (const seg of segments(text, NODE_SEG)) {
    if (seg === '') continue;
    const opts = sedGroup(seg, OPTS_RE, 3) ?? '';
    const o = ` ${opts}`;
    if (o.includes(' --check ') || o.includes(' -c ')) continue;
    if (new RegExp(`(proofline-core([.]mjs|[^${ID}]|$)|[.]agents/scripts/core/)`).test(seg)) return true;
    const op = sedGroup(seg, OP_RE, 4) ?? '';
    if (op.includes('.agents/scripts')) return true;
  }
  // the core run as a command word (its shebang starts Node)
  return text.replace(SEP, '\n').split('\n').some((l) => new RegExp(`^[${S}]*(env[${S}]+)?[^${S}]*proofline-core[.]mjs`).test(l));
}

/** `tw_lit TOKEN`: is TOKEN a plain literal path? One pair of surrounding quotes is fine. @param {string} tok */
export function twLit(tok) {
  let t = tok;
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  else if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) t = t.slice(1, -1);
  return !/[$`*?[~{\\"']/.test(t);
}

/** `tw_node_operand TEXT`. @param {string} text */
export function twNodeOperand(text) {
  if (!text.includes('node')) return false;
  const named = grepq(/(proofline-core|[.]agents\/scripts)/, text);
  for (const seg of segments(text, NODE_SEG)) {
    if (seg === '') continue;
    const opts = `${sedGroup(`${seg} `, OPTS_RE, 3) ?? ''} `;
    const op = sedGroup(`${seg} `, OP_RE, 4) ?? '';
    const feed = seg.includes('xargs') || seg.includes('-exec');
    const o = ` ${opts}`;
    if (o.includes(' - ')) return true;
    if (op === '/dev/stdin' || op.startsWith('/dev/fd/') || op.startsWith('/proc/self/fd/') || /^\/proc\/[^]*\/fd\//.test(op)) return true;
    if (o.includes(' --test ') || o.includes(' --test-')) {
      // operands are test patterns: a glob is theirs, a variable, a substitution or a path under .agents is not
      if (seg.includes('$') || seg.includes('`') || seg.includes('.agents')) return true;
      continue;
    }
    if (o.includes(' --check ') || o.includes(' -c ') || o.includes(' -e ') || o.includes(' -p ') || o.includes(' -pe ') || o.includes(' --eval ') || o.includes(' --print ')
      || o.includes(' -v ') || o.includes(' --version ') || o.includes(' -h ') || o.includes(' --help ') || o.includes(' --input-type')) continue;
    if (op !== '') { if (!twLit(op)) return true; } else if (feed) return true; // no operand: the script comes from stdin or from xargs / find -exec
    if (feed && named) return true;
  }
  const pf = text.replace(/\n/g, ' ');
  const sp = ` ${pf}`;
  // the replacement operand of xargs / find -exec: `node {}` and `xargs -I<str> ... node <str>`
  if (!(sp.includes(' --test') || sp.includes(' -e ') || sp.includes(' -p ') || sp.includes(' --eval ') || sp.includes(' --print ') || sp.includes(' --check ') || sp.includes(' -c '))) {
    if (new RegExp(`(^|[^${ID}])(node|nodejs)[${S}]+(-[^${S}]*[${S}]+)*[{][${S}]*[}]`).test(pf)) return true;
    if (new RegExp(`xargs[^;&|]*[${S}](-I|-J|--replace)[^;&|]*[${S}](node|nodejs)([${S}]|$)`).test(pf)) return true;
  }
  // brace expansion in the operand ({a,b}.mjs): not for `node --test`, whose patterns may use braces
  if (!sp.includes(' --test') && new RegExp(`(^|[^${ID}])(node|nodejs)[${S}]+(-[^${S}]*[${S}]+)*([^${S}{-][^${S}{]*)?[{][^}${S}]`).test(pf)) return true;
  // a pipe or redirect that feeds a node word with no operand at all (cat prog.mjs | node; node < prog.mjs)
  if (!new RegExp(`([|<][${S}]*((env|npx|command|exec)[${S}]+)*(node|nodejs)([${S}]+-[^${S}]*)*[${S}]*($|[;&|)]))|((node|nodejs)([${S}]+-[^${S}]*)*[${S}]*<[^<])`).test(pf)) return false;
  if (sp.includes(' -e ') || sp.includes(' -p ') || sp.includes(' --eval ') || sp.includes(' --print ') || sp.includes(' --test') || sp.includes(' --check ') || sp.includes(' -c ') || sp.includes(' -v ') || sp.includes(' --version')) return false;
  return true;
}
