#!/bin/sh
# Task slug (A202): slug.sh <title> prints the file and branch slug of a task title.
# Turkish and other Latin letters become their ASCII equivalents first (ç c, ğ g, ı i, İ i, ö o, ş s, ü u, é e, ß ss ...),
# then everything that is not a letter or digit becomes one `-`; lowercase, at most 48 characters, no leading or trailing `-`.
# One implementation: agent.sh (branch name), the markdown adapter (file name) and the task validator's tests agree.
# Prints nothing for a title without a usable letter or digit.
LC_ALL=C; export LC_ALL
# "<target> <letter>..." per line; a letter is a whole UTF-8 sequence, so the substitutions are plain strings (bytewise in the C locale)
table='c ç Ç ć č ĉ ċ
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
oe œ Œ'
title=${1:-}
script=''
while IFS= read -r row; do
  # shellcheck disable=SC2086 # the row is words on purpose
  set -- $row; to=$1; shift
  for ch in "$@"; do script="${script}s/$ch/$to/g;"; done
done <<TABLE
$table
TABLE
printf '%s' "$title" | sed "$script" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-48 | sed 's/-$//'
