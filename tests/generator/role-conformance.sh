#!/bin/sh
# shellcheck disable=SC2016
# Conformance check for roles/*.md against roles/README.md: key order, enums, tier floors, D5 profile rules,
# body sections, skill references, result header, severity values, finding ids, RESULT sets, the no-spawn
# rule and owns/tools/sandbox/writes_code consistency.
# Usage: role-conformance.sh [--root REPO | ROLES-DIR]   (default: the repository's roles/)
case ${1:-} in
  --root) d=$2/roles ;;
  '') d=$(dirname "$0")/../../roles ;;
  *) d=$1 ;;
esac
fail=0
keys="id name purpose conditional reads owns skills gate result tools writes_code sandbox model effort tier_floor timeout_seconds stop_condition"
skills_all="proofline-lead task-author intent-grill evidence-map plan-contract system-design api-design data-design ui-design qa-plan tdd-proof debug-proof test-trust proof-review exploit-proof verify-proof design-sync concurrency-proof visual-proof performance-proof contract-proof"
gates_all="REVIEW_PLAN REVIEW_RULES REVIEW_TESTS REVIEW_DATA REVIEW_SMALL SECURITY QA VERIFY"
for f in "$d"/*.md; do
  b=$(basename "$f" .md); [ "$b" = README ] && continue
  out=$(awk -v keys="$keys" -v base="$b" -v sk="$skills_all" -v ga="$gates_all" '
    BEGIN{n=split(keys,K," "); m=split(sk,S," "); for(i=1;i<=m;i++) okskill[S[i]]=1; m=split(ga,G," "); for(i=1;i<=m;i++) okgate[G[i]]=1
      tier["haiku"]=1;tier["sonnet"]=2;tier["opus"]=3;tier["gpt-6-luna"]=1;tier["gpt-6-sol"]=2;tier["gpt-6-astra"]=3; p[1]="max";p[2]="balanced";p[3]="economy"
      GATE_RES="RESULT: <PASS|FAIL|BLOCKED>"; TASK_RES="RESULT: <DONE|BLOCKED|NEEDS_INPUT>"}
    NR==1 && $0!="---" {print "no opening ---"}
    NR>1 && fm==0 && $0=="---" {fm=1; next}
    NR>1 && fm==0 {
      if ($0 ~ /^  /) { sub(/^  /,""); split($0,a,": "); sub(/:$/,"",a[1]); sc++; want=p[(sc-1)%3+1];
        if (a[1] ":" != want ":" ) print "sub-line order " cur " got " a[1] " want " want;
        if (cur=="model") { if (a[2] !~ /^claude=[a-z]+ codex=gpt-6-[a-z]+$/) print "bad model line " $0; split(a[2],mm," "); sub(/claude=/,"",mm[1]); sub(/codex=/,"",mm[2]); mt[want]=mm[1]; ct[want]=mm[2] }
        if (cur=="effort" && a[2] !~ /^(low|medium|high|xhigh)$/) print "bad effort " $0
        next }
      k=$0; sub(/:.*/,"",k); v=$0; sub(/^[^:]*: ?/,"",v); ki++;
      if (k!=K[ki]) print "key " ki " is " k " want " K[ki];
      cur=k; val[k]=v; if (v ~ /#/) print "hash in " k; if (k!="model" && k!="effort" && v=="") print "empty " k
      next }
    fm==1 { body=body $0 "\n"; if ($0 ~ /^## /) h[++hn]=$0
      if ($0 ~ /^RESULT: /) { if ($0==GATE_RES || (base=="reviewer" && $0=="RESULT: <PASS|FAIL|BLOCKED|UNSUPPORTED>")) rg=1; else if ($0==TASK_RES) rt=1; else print "bad RESULT line " $0 }
      # severity: exactly blocking | info
      if ($0 ~ /(^|[^A-Za-z_])(INFO|HIGH|MEDIUM|LOW)([^A-Za-z_]|$)/) print "old severity word: " $0
      if (tolower($0) ~ /severity/ && $0 !~ /^\| id \| severity/) {
        if ($0 ~ /CRITICAL/) print "old severity word: " $0
        l=substr($0, index(tolower($0), "severity")); if (match(l, /`[^`]+`/)) { w=substr(l,RSTART+1,RLENGTH-2); if (w!="blocking" && w!="info") print "bad severity value " w } }
      # finding ids: `<prefix>-<n>`
      l=$0; while (match(l, /`[A-Za-z_<>]+-<n>`/)) { idp=substr(l,RSTART+1,RLENGTH-6); ids[idp]=1; nid++; l=substr(l,RSTART+RLENGTH) }
      l=$0; while (match(l,/\{\{skill:[a-z-]+\}\}/)) { s=substr(l,RSTART+8,RLENGTH-10); if(!okskill[s]) print "unknown skill ref " s; ref[s]=1; l=substr(l,RSTART+RLENGTH) } }
    END{
      if (val["id"]!=base) print "id mismatch";
      if (h[1]!="## Does / Must not" || h[2]!="## Method" || h[3]!="## Output" || hn!=3) print "body sections wrong";
      split(val["skills"],SS," "); for(i in SS){ if(!okskill[SS[i]]) print "unknown skill " SS[i]; if(!ref[SS[i]]) print "skill not referenced in method " SS[i] }
      for(i=1;i<=3;i++){ q=p[i]; if(tier[mt[q]]=="" || tier[ct[q]]=="") print "unknown model " q; if(tier[mt[q]]!=tier[ct[q]]) print "tier mismatch " q; if(tier[mt[q]]<val["tier_floor"]) print "below floor " q }
      if (val["timeout_seconds"]+0<30) print "timeout";
      # gate / result kind / RESULT value set
      g=(val["gate"]!="none"); if (g != (val["result"]=="gate")) print "gate/result";
      split(val["gate"],GG," "); if (g) for(i in GG) if(!okgate[GG[i]]) print "unknown gate " GG[i];
      if (val["result"]=="gate") { if (!rg) print "gate role lacks " GATE_RES; if (rt && base!="qa") print "gate role with task RESULT set" }
      else if (val["result"]=="task") { if (!rt) print "task role lacks " TASK_RES; if (rg) print "task role with gate RESULT set" }
      else print "bad result kind " val["result"];
      # finding ids per kind: gate -> <GATE>-<n>; task -> <id>-<n>; qa plan step qa-<n>
      for (x in ids) {
        okid = (val["result"]=="task" && x==base) || (val["result"]=="gate" && (okgate[x] || x=="<GATE>")) || (base=="qa" && x=="qa")
        if (!okid) print "bad finding id " x "-<n>" }
      if (base!="lead" && !nid) print "no finding id format";
      if (base=="qa" && (!ids["qa"] || !ids["QA"])) print "qa needs qa-<n> and QA-<n>";
      # no spawn
      if (val["tools"] ~ /(^| )(Agent|Task)( |$)/) print "spawn tool";
      if (base=="lead") { if (body !~ /Let a specialist dispatch another/) print "no-spawn rule missing" }
      else if (tolower(body) !~ /spawn agents/) print "no-spawn rule missing";
      # owns / tools / sandbox / writes_code
      no=split(val["owns"],OW," "); ps=0
      for(i=1;i<=no;i++){ t=OW[i]
        if (t=="PRODUCT_SCOPE") ps=1
        else if (t ~ /^\//) { if (t !~ /\.md$/ && t !~ /^\/\.agents\//) print "project-relative owns token not a doc: " t }
        else if (t !~ /^[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/ || t ~ /\.\./) print "bad owns token " t }
      wr=(val["tools"] ~ /(^| )Write( |$)/ && val["tools"] ~ /(^| )Edit( |$)/)
      if (no>0 && !wr) print "owns paths but no Write/Edit";
      if (wr && no==0) print "Write/Edit without owns";
      if (wr != (val["sandbox"]=="workspace-write")) print "sandbox " val["sandbox"] " vs tools";
      if ((val["writes_code"]=="yes") != (base=="implementer")) print "writes_code";
      if (ps != (val["writes_code"]=="yes")) print "PRODUCT_SCOPE vs writes_code";
      if (val["writes_code"]!="yes" && val["writes_code"]!="no") print "writes_code value";
      if (body !~ ("ROLE: " base "\n")) print "header ROLE missing";
      if (body !~ /\| id \| severity \| path:line \| finding \| evidence \|/) print "findings table missing";
      if (val["result"]=="task" && body !~ /QUESTIONS:/) print "no QUESTIONS format";
    }' "$f")
  # D5 profile rules
  model() { awk -v p="$2" '$1==p":"{sub(/claude=/,"",$2); print $2; exit}' "$1"; }
  case $b in lead|architect|data_architect) [ "$(model "$f" balanced)" = opus ] || out="$out balanced-not-opus";;
    explorer|implementer|verifier|designer|reviewer) [ "$(model "$f" balanced)" = sonnet ] || out="$out balanced-not-sonnet";; esac
  if [ "$b" = security_reviewer ]; then for q in max balanced economy; do [ "$(model "$f" $q)" = opus ] || out="$out sec-not-opus-$q"; done
    grep -q '^tier_floor: 3$' "$f" || out="$out sec-floor"
  else [ "$(model "$f" economy)" = opus ] && out="$out economy-opus"; fi
  [ "$(model "$f" max)" = opus ] || out="$out max-not-opus"
  grep -q '^FOCUS:' "$f" && [ "$b" != reviewer ] && out="$out stray-FOCUS"
  [ "$b" = reviewer ] && { grep -q '^FOCUS: <plan|rules|tests|data|rules+tests|contract|concurrency|performance|config|migration>$' "$f" || out="$out no-FOCUS"; }
  n=$(wc -l < "$f"); { [ "$n" -lt 60 ] || [ "$n" -gt 160 ]; } && out="$out lines=$n"
  if [ -n "$out" ]; then echo "FAIL $b:$out" | tr '\n' ' '; echo; fail=1; else echo "ok $b ($n lines)"; fi
done
c=0; for x in "$d"/*.md; do [ "$(basename "$x")" = README.md ] || c=$((c+1)); done; [ "$c" = 11 ] || { echo "FAIL count $c"; fail=1; }
# README states the severity set
if [ -f "$d/README.md" ]; then
  grep -q '`severity` is exactly `blocking` or `info`' "$d/README.md" || { echo "FAIL README: severity set"; fail=1; }
  grep -Eq '(^|[^A-Za-z_])(INFO|HIGH|MEDIUM|LOW)([^A-Za-z_]|$)' "$d/README.md" && { echo "FAIL README: old severity word"; fail=1; }
fi
exit $fail
