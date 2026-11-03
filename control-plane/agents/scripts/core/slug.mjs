// @ts-check
// The task slug (A202) of the branch name: Turkish and other Latin letters become ASCII, everything else that is not a letter or digit one `-`,
// lower case, at most 48 characters. The table is the one of the former task-integrations/slug.sh (A216: the adapters, the branch name and `cli slug` use this one);
// tests/core/run4a-records.test.mjs holds known answers.
import { bytes } from './config.mjs';

const TABLE = `c ç Ç ć č ĉ ċ
g ğ Ğ ĝ ġ ģ
i ı İ ì í î ï ĩ ī ĭ į Ì Í Î Ï Ĩ Ī Ĭ Į
o ö Ö ò ó ô õ ø ō ŏ ő Ò Ó Ô Õ Ø Ō Ŏ Ő
s ş Ş ś š ŝ Ś Š Ŝ
u ü Ü ù ú û ũ ū ŭ ů ű ų Ù Ú Û Ũ Ū Ŭ Ů Ű Ų
a à á â ã ä å ā ă ą À Á Â Ã Ä Å Ā Ă Ą
e è é ê ë ē ĕ ė ę ě È É Ê Ë Ē Ĕ Ė Ę Ě
n ñ ń ň ņ Ñ Ń Ň Ņ
y ý ÿ Ý Ÿ
z ž ź ż Ž Ź Ż
r ř ŕ Ř Ŕ
d ď đ Ď Đ
l ł ľ ĺ Ł Ľ Ĺ
t ť ţ Ť Ţ
ss ß
ae æ Æ
oe œ Œ`;

/** @type {Array<[string, string]>} */
const MAP = [];
for (const row of TABLE.split('\n')) {
  const [to, ...letters] = row.split(' ');
  for (const l of letters) MAP.push([l, to]);
}

/** `slug.sh TITLE` over a byte string. @param {string} title @returns {string} */
export function slug(title) {
  let s = Buffer.from(title, 'latin1').toString('utf8');
  for (const [from, to] of MAP) s = s.split(from).join(to);
  s = bytes(s).replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  return s.slice(0, 48).replace(/-$/, '');
}
