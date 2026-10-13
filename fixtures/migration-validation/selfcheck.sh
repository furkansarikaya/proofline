#!/bin/sh
# Runs the dependency-free migration helpers over the built fixture ($1) and asserts the planted facts.
# Needs node; prints SKIP and exits 0 when it is missing.
set -eu
dir=$1
here=$(cd "$(dirname "$0")" && pwd)
skill=$here/../../skills/data-design/scripts
command -v node >/dev/null 2>&1 || { echo "SKIP migration-validation selfcheck: node not found"; exit 0; }
cd "$dir"
MC="node $skill/migration-check.mjs"

sum='let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.hazards.map(h=>h.code+":"+h.evidence_class).join(",")+"|"+j.not_executable.length)})'
check() { # scenario expected [extra scan options...]
  s=$1; want=$2; shift 2
  f=$(ls scenarios/"$s"/migration/*.sql)
  got=$($MC scan --engine postgres "$@" --context migrations/001_create_users.sql migrations/002_create_orders.sql --readers src -- "$f" | node -e "$sum")
  [ "$got" = "$want" ] || { echo "FAIL scan $s: expected '$want' got '$got'"; exit 1; }
}
check clean-additive "|0"
check notnull-no-default "H01:traced|1" --populated users
check notnull-no-default "H01:judged|1"
check rename-expand-contract "|0"
check rename-in-place "H05:traced|0"
check index-create "H04:judged|0"
check type-narrow "H02:traced,H03:judged|1"
check drop-column-read "H05:traced|1"

$MC diff scenarios/clean-additive/before.sql scenarios/clean-additive/after.sql --rollback scenarios/clean-additive/after-rollback.sql | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);
  const ok=j.diff.tables_added.join()==="audit_log"&&j.diff.columns_added.length===1&&j.diff.columns_added[0].column==="notes"&&
    j.rollback.restores_schema===true&&j.compatibility.old_app_on_new_schema.length===0&&j.compatibility.new_app_on_old_schema.length===2;
  if(!ok){console.log("FAIL diff clean-additive");process.exit(1)}})'
$MC diff scenarios/rename-in-place/before.sql scenarios/rename-in-place/after.sql | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);
  const ok=j.diff.columns_removed.some(c=>c.column==="name")&&j.compatibility.old_app_on_new_schema.some(c=>c.object==="users.name");
  if(!ok){console.log("FAIL diff rename-in-place");process.exit(1)}})'
for s in clean-additive rename-expand-contract index-create; do
  $MC data scenarios/$s/seed-before.json scenarios/$s/seed-after.json | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{if(JSON.parse(d).preserved!==true){console.log("FAIL data preserved");process.exit(1)}})'
done
$MC data scenarios/rename-in-place/seed-before.json scenarios/rename-in-place/seed-after.json | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);
  const u=j.tables.users;if(!(u.missing.length===0&&u.renamed_columns.some(r=>r.from==="name"&&r.to==="full_name"))){console.log("FAIL data rename");process.exit(1)}})'
echo "migration-validation selfcheck ok"
