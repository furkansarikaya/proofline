#!/bin/sh
# `proofline insights` (A89): a read-only report on cost and recurring failures. Sourced by bin/proofline.
# Reads .agents/local/metrics/records.jsonl (A80) and, per run, LEDGER.log, gates/*.yaml and results/*.result.md.
# It opens nothing for writing: no rule, skill, config, ledger or metrics file is ever changed.
# Needs say, die, ROOT, CFG, require_installed from bin/proofline and cfg_val from config.sh.

insights_usage() { say "usage: proofline insights [--run <ID>] [--json]"; }

# insights_stream RUN_ID_OR_EMPTY: tagged lines for the aggregator, one source file at a time.
#   M <json>            a metrics record
#   R <run>             a run directory exists
#   L <run> <row>       a ledger row
#   G <run> <file> <l>  a `result:` or `finding:` line of a gate record
#   U <run> <file> <l>  a line of a recorded result that names UNSUPPORTED
insights_stream() {
  is_only=$1
  is_mf=$ROOT/.agents/local/metrics/records.jsonl
  if [ -f "$is_mf" ]; then awk '{ print "M\t" $0 }' "$is_mf"; fi
  for is_rd in "$ROOT"/.agents/runs/*/; do
    [ -d "$is_rd" ] || continue
    is_id=$(basename "$is_rd")
    [ -z "$is_only" ] || [ "$is_id" = "$is_only" ] || continue
    printf 'R\t%s\n' "$is_id"
    set --
    for is_f in "$is_rd/LEDGER.log" "$is_rd"gates/*.yaml "$is_rd"results/*.result.md; do
      [ -f "$is_f" ] && [ ! -L "$is_f" ] && set -- "$@" "$is_f"
    done
    [ $# -gt 0 ] || continue
    awk -v r="$is_id" '
      FNR == 1 { fn = FILENAME; sub(/.*\//, "", fn); kind = (fn == "LEDGER.log") ? "L" : (fn ~ /\.yaml$/ ? "G" : "U") }
      kind == "L" { print "L\t" r "\t" $0; next }
      kind == "G" && /^(result|finding):/ { print "G\t" r "\t" fn "\t" $0; next }
      kind == "U" && /UNSUPPORTED/ { print "U\t" r "\t" fn "\t" $0 }
    ' "$@"
  done
}

cmd_insights() {
  require_installed
  in_run='' in_json=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) in_json=1 ;;
      --run) [ $# -ge 2 ] || { insights_usage >&2; die "--run needs a run id"; }; in_run=$2; shift ;;
      --run=*) in_run=${1#--run=} ;;
      -h|--help) insights_usage; return 0 ;;
      *) insights_usage >&2; die "unknown argument: $1" ;;
    esac
    shift
  done
  case "$in_run" in *[!A-Za-z0-9_-]*) die "invalid run id: $in_run" ;; esac
  if [ -n "$in_run" ] && [ ! -d "$ROOT/.agents/runs/$in_run" ]; then
    grep -qF "\"task\":\"$in_run\"" "$ROOT/.agents/local/metrics/records.jsonl" 2>/dev/null || die "no such run: $in_run (see: proofline queue)"
  fi
  in_off=0; [ "$(cfg_val "$CFG" metrics on)" != off ] || in_off=1
  insights_stream "$in_run" | LC_ALL=C awk -v json="$in_json" -v only="$in_run" -v off="$in_off" '
    function jv(s, k,   p, i, r) {
      p = "\"" k "\":"; i = index(s, p); if (!i) return ""
      r = substr(s, i + length(p))
      if (substr(r, 1, 1) == "\"") { r = substr(r, 2); sub(/".*/, "", r); return r }
      sub(/[,}].*/, "", r); return (r == "null") ? "" : r
    }
    function isnum(v) { return v ~ /^[0-9]+$/ }
    function add(g, key, w1, w2, w3, w4, w5,   i, v) {
      C[g, key]++
      for (i = 1; i <= 5; i++) { v = (i == 1) ? w1 : (i == 2) ? w2 : (i == 3) ? w3 : (i == 4) ? w4 : w5; if (isnum(v)) { S[g, key, i] += v; N[g, key, i]++ } }
    }
    # a sum is shown only over recorded values; "n/a" when none was recorded; "(k/n)" when only k of n were
    function cell(g, key, i,   n, c) {
      n = N[g, key, i] + 0; c = C[g, key] + 0
      if (n == 0) return "n/a"
      return (n < c) ? S[g, key, i] " (" n "/" c ")" : S[g, key, i] ""
    }
    function jcell(g, key, i) { return (N[g, key, i] + 0 == 0) ? "null" : S[g, key, i] "" }
    function jesc(s,   o, i, c) {
      o = ""; for (i = 1; i <= length(s); i++) { c = substr(s, i, 1)
        if (c == "\\") o = o "\\\\"; else if (c == "\"") o = o "\\\""; else if (c < " ") o = o " "; else o = o c }
      return o
    }
    function isort(a, n,   i, j, t) { for (i = 2; i <= n; i++) { t = a[i]; for (j = i - 1; j >= 1 && a[j] > t; j--) a[j + 1] = a[j]; a[j + 1] = t } }
    function addset(nm, key, v) { if (!((nm, key, v) in SET)) { SET[nm, key, v] = 1; LST[nm, key] = LST[nm, key] (LST[nm, key] == "" ? "" : ",") v } }
    function norm(s) { gsub(/[ \t]+/, " ", s); sub(/^ /, "", s); sub(/ $/, "", s); return s }
    function addpat(kind, subj, cnt, runs, sugg) {
      np++; pk[np] = kind; ps[np] = subj; pc[np] = cnt; pr[np] = runs; pg[np] = sugg
      pord[sprintf("%09d|%s|%s|%06d", 999999999 - cnt, kind, subj, np)] = np
    }
    function gsugg(g) {
      if (g == "SECRETS") return "Find what keeps putting secret-like text into diffs (fixtures, env files, examples) and keep it out on purpose, or record a reason for each deliberate exception."
      if (g == "SECURITY") return "Read the repeated security findings together: if they share a cause, state the rule in the plan so the implementer sees it before the gate does."
      if (g == "QA") return "Make the failing acceptance criteria more concrete in the task, so the implementer and QA read the same test."
      if (g == "VERIFY") return "Check whether the verify commands are stable on this machine; a gate that fails the same way every time usually points to an environment or flaky-test cause."
      return "Read the repeated findings of this gate; if they share a cause, name it in the plan or the task so it is handled before review."
    }
    BEGIN { FS = "\t" }
    $1 == "M" {
      j = substr($0, 3)
      if (j !~ /^[ \t]*\{/) { if (j ~ /[^ \t]/) nonjson++; next }
      if (jv(j, "schema") != "proofline.metrics/1") { skipped++; next }
      t = jv(j, "task"); if (t == "" || (only != "" && t != only)) next
      nrec++; known[t] = 1
      kd = jv(j, "kind"); ro = jv(j, "role"); mo = jv(j, "model"); if (mo == "") mo = "n/a"; if (ro == "") ro = "n/a"
      if (kd == "dispatch") {
        d = jv(j, "duration_s"); ti = jv(j, "tokens_in"); to = jv(j, "tokens_out"); tt = jv(j, "tokens_total"); re = jv(j, "retries")
        add("run", t, d, ti, to, re, tt); add("rm", ro "|" mo, d, ti, to, re, tt); add("model", mo, d, ti, to, re, tt); add("all", "all", d, ti, to, re, tt)
        rm_seen[ro "|" mo] = 1; md_seen[mo] = 1; ndisp++
      } else if (kd == "run") {
        if (t in hasrun) { dupruns++; next }   # one run record per run: the first counts
        hasrun[t] = 1; rres[t] = jv(j, "result"); rdur[t] = jv(j, "duration_s"); rdel[t] = jv(j, "delegations"); rfix[t] = jv(j, "fix_rounds")
        add("runrec", "all", rdur[t], rdel[t], rfix[t], "", "")
      }
      next
    }
    $1 == "R" { known[$2] = 1; hasdir[$2] = 1; next }
    $1 == "L" {
      r = $2; row = substr($0, length($1 $2) + 3); known[r] = 1
      if (!match(row, / event=[^ ]+/)) next
      ev = substr(row, RSTART + 7, RLENGTH - 7); i = index(row, " detail="); d = (i ? substr(row, i + 8) : "")
      if (ev ~ /^gate:/) {
        split(ev, p, ":")
        if (match(d, /gates\/[0-9][0-9][0-9]-[A-Z_]+\.yaml@/)) bound[r, substr(d, RSTART + 6, RLENGTH - 7)] = 1
        if (p[3] == "fail") { gf[p[2]]++; addset("gf", p[2], r) }
      } else if (ev ~ /^record:/) {
        if (match(d, /^results\/[^ ]+\.result\.md/)) bound[r, substr(d, 9, RLENGTH - 8)] = 1
      } else if (ev == "approval-request" || ev == "approval") {
        split(d, w, " "); k = w[1]; if (k ~ /^approvals\//) k = w[2]
        if (k != "") { if (ev == "approval") grants[r, k]++; else asks[r, k]++; akind[r, k] = 1; aruns[r] = 1 }
      }
      next
    }
    $1 == "G" {
      r = $2; fn = $3; line = substr($0, length($1 $2 $3) + 4)
      if (!((r, fn) in bound)) next
      if (line !~ /^finding:/) next
      sub(/^finding: */, "", line); n = split(line, f, "|")
      if (n < 4 || f[2] != "blocking") next
      g = fn; sub(/^[0-9]+-/, "", g); sub(/\.yaml$/, "", g)
      path = norm(f[3]); sub(/:.*$/, "", path); txt = norm(f[4])
      key = g "|" path "|" txt
      if (!((r, fn, key) in fseen)) {
        fseen[r, fn, key] = 1; fcount[key]++; addset("f", key, r)
        low = tolower(txt)
        if (low ~ /out[ -]of[ -]scope|outside (of )?(the )?(frozen |plan |plan.s )?scope|unmapped|scope (violation|creep)|not in (the )?(plan |frozen )?scope|unauthori[sz]ed path/) {
          scopen++; addset("scope", "all", r)
        }
      }
      next
    }
    $1 == "U" {
      r = $2; fn = $3; line = norm(substr($0, length($1 $2 $3) + 4))
      if (!((r, fn) in bound)) next
      if (length(line) > 160) line = substr(line, 1, 160) "..."
      ucount[line]++; addset("u", line, r)
      next
    }
    END {
      # ---- recurring patterns (a pattern needs at least two occurrences) ----
      for (key in fcount) if (fcount[key] >= 2) {
        split(key, kp, "|"); txt = substr(key, length(kp[1] kp[2]) + 3)
        addpat("repeated-finding", kp[1] " " kp[2] ": " ((length(txt) > 200) ? substr(txt, 1, 200) "..." : txt), fcount[key], LST["f", key],
          "The same blocking finding came back " fcount[key] " times. Put it in the task acceptance criteria or the plan so it is handled before review, and consider a test or validator that catches it earlier.")
      }
      for (g in gf) if (gf[g] >= 2) addpat("gate-fail", g, gf[g], LST["gf", g], gsugg(g))
      if (scopen >= 2) addpat("scope", "findings that name a scope violation", scopen, LST["scope", "all"],
        "Findings keep naming paths outside the plan scope. List the files the task really touches in the plan scope at planning time (ask the explorer for the impact), or split the task so each plan stays small.")
      for (u in ucount) if (ucount[u] >= 2) addpat("unsupported", u, ucount[u], LST["u", u],
        "A check could not run because the project lacks the tool or capability it needs, so its result is UNSUPPORTED, not PASS. Proofline never installs anything: add the tool yourself if you want the check to run, or accept that it stays unsupported.")
      for (rk in akind) {
        split(rk, q, SUBSEP); r = q[1]; k = q[2]
        a = asks[r, k] + 0; gr = grants[r, k] + 0
        if (a >= 2 && gr < a) { unmet[k] += a - gr; addset("ap", k, r) }
      }
      for (k in unmet) if (unmet[k] >= 2) addpat("approval", k, unmet[k], LST["ap", k],
        "The " k " approval was asked for more often than it was granted (refused, or never answered). Check that the question was clear and the plan is what you wanted to approve; approval phrases are listed in approval.phrases of .agents/config.yaml.")
      po = 0; for (k in pord) ordk[++po] = k; isort(ordk, po)

      # ---- run list ----
      nr = 0; for (r in known) rl[++nr] = r; isort(rl, nr)
      nm = 0; for (k in rm_seen) rml[++nm] = k; isort(rml, nm)
      nd = 0; for (k in md_seen) mdl[++nd] = k; isort(mdl, nd)

      if (json == 1) {
        printf "{\"schema\":\"proofline.insights/1\",\"run\":%s,\"metrics\":{\"records\":%d,\"skipped_unknown_schema\":%d,\"skipped_non_json\":%d,\"duplicate_run_records\":%d,\"off\":%s},\n", (only == "" ? "null" : "\"" jesc(only) "\""), nrec + 0, skipped + 0, nonjson + 0, dupruns + 0, (off == 1 ? "true" : "false")
        printf " \"runs\":["
        for (i = 1; i <= nr; i++) { r = rl[i]
          printf "%s{\"run\":\"%s\",\"result\":%s,\"duration_s\":%s,\"dispatches\":%d,\"tokens_in\":%s,\"tokens_in_reported\":%d,\"tokens_out\":%s,\"tokens_out_reported\":%d,\"tokens_total\":%s,\"tokens_total_reported\":%d,\"retries\":%s,\"delegations\":%s,\"fix_rounds\":%s}",
            (i > 1 ? "," : ""), jesc(r), (hasrun[r] && rres[r] != "" ? "\"" jesc(rres[r]) "\"" : "null"), (isnum(rdur[r]) ? rdur[r] : "null"), C["run", r] + 0,
            jcell("run", r, 2), N["run", r, 2] + 0, jcell("run", r, 3), N["run", r, 3] + 0, jcell("run", r, 5), N["run", r, 5] + 0, jcell("run", r, 4), (isnum(rdel[r]) ? rdel[r] : "null"), (isnum(rfix[r]) ? rfix[r] : "null") }
        printf "],\n \"by_role_model\":["
        for (i = 1; i <= nm; i++) { k = rml[i]; split(k, q, "|")
          printf "%s{\"role\":\"%s\",\"model\":\"%s\",\"dispatches\":%d,\"duration_s\":%s,\"tokens_in\":%s,\"tokens_in_reported\":%d,\"tokens_out\":%s,\"tokens_out_reported\":%d,\"tokens_total\":%s,\"tokens_total_reported\":%d,\"retries\":%s}",
            (i > 1 ? "," : ""), jesc(q[1]), jesc(q[2]), C["rm", k] + 0, jcell("rm", k, 1), jcell("rm", k, 2), N["rm", k, 2] + 0, jcell("rm", k, 3), N["rm", k, 3] + 0, jcell("rm", k, 5), N["rm", k, 5] + 0, jcell("rm", k, 4) }
        printf "],\n \"by_model\":["
        for (i = 1; i <= nd; i++) { k = mdl[i]
          printf "%s{\"model\":\"%s\",\"dispatches\":%d,\"duration_s\":%s,\"tokens_in\":%s,\"tokens_in_reported\":%d,\"tokens_out\":%s,\"tokens_out_reported\":%d,\"tokens_total\":%s,\"tokens_total_reported\":%d,\"retries\":%s}",
            (i > 1 ? "," : ""), jesc(k), C["model", k], jcell("model", k, 1), jcell("model", k, 2), N["model", k, 2] + 0, jcell("model", k, 3), N["model", k, 3] + 0, jcell("model", k, 5), N["model", k, 5] + 0, jcell("model", k, 4) }
        printf "],\n \"totals\":{\"dispatches\":%d,\"dispatch_duration_s\":%s,\"tokens_in\":%s,\"tokens_in_reported\":%d,\"tokens_out\":%s,\"tokens_out_reported\":%d,\"tokens_total\":%s,\"tokens_total_reported\":%d,\"retries\":%s,\"run_duration_s\":%s,\"run_records\":%d,\"delegations\":%s,\"fix_rounds\":%s},\n",
          C["all", "all"] + 0, jcell("all", "all", 1), jcell("all", "all", 2), N["all", "all", 2] + 0, jcell("all", "all", 3), N["all", "all", 3] + 0, jcell("all", "all", 5), N["all", "all", 5] + 0, jcell("all", "all", 4),
          jcell("runrec", "all", 1), C["runrec", "all"] + 0, jcell("runrec", "all", 2), jcell("runrec", "all", 3)
        printf " \"patterns\":["
        for (i = 1; i <= po; i++) { x = pord[ordk[i]]
          printf "%s{\"kind\":\"%s\",\"subject\":\"%s\",\"count\":%d,\"runs\":[", (i > 1 ? "," : ""), jesc(pk[x]), jesc(ps[x]), pc[x]
          m = split(pr[x], rr, ","); for (j = 1; j <= m; j++) printf "%s\"%s\"", (j > 1 ? "," : ""), jesc(rr[j])
          printf "],\"suggestion\":\"%s\"}", jesc(pg[x]) }
        printf "]}\n"
        exit
      }

      print "proofline insights (read-only report: nothing was changed)"
      if (only != "") print "run filter: " only
      if (nrec == 0) print "metrics: no metrics recorded" (off ? " (metrics: off)" : "") " (.agents/local/metrics/records.jsonl)"
      else print "metrics: " nrec " record(s)" (off ? " (metrics: off now; earlier records are shown)" : "") (skipped ? ", " skipped " with an unknown schema skipped" : "") (nonjson ? ", " nonjson " non-JSON line(s) ignored" : "") (dupruns ? ", " dupruns " duplicate run record(s) ignored (the first counts)" : "")
      print "runs: " nr
      print ""
      print "COST (tokens are what the runtime reported; n/a = none recorded, never estimated; (k/n) = k of n dispatches reported)"
      if (nr == 0) print "  no runs and no metrics to report"
      else {
        printf "  %-22s %-12s %9s %5s %-16s %-16s %-16s %7s %6s %5s\n", "RUN", "RESULT", "DURATION", "DISP", "TOKENS_IN", "TOKENS_OUT", "TOKENS_TOTAL", "RETRIES", "DELEG", "FIX"
        for (i = 1; i <= nr; i++) { r = rl[i]
          res = (hasrun[r] && rres[r] != "") ? rres[r] : (hasdir[r] ? "open" : "n/a")
          printf "  %-22s %-12s %9s %5d %-16s %-16s %-16s %7s %6s %5s\n", r, res, (isnum(rdur[r]) ? rdur[r] "s" : "n/a"), C["run", r] + 0, cell("run", r, 2), cell("run", r, 3), cell("run", r, 5), cell("run", r, 4), (isnum(rdel[r]) ? rdel[r] : "n/a"), (isnum(rfix[r]) ? rfix[r] : "n/a")
        }
      }
      if (nm > 0) {
        print ""
        printf "  %-18s %-18s %5s %9s %-16s %-16s %-16s %7s\n", "ROLE", "MODEL", "DISP", "DURATION", "TOKENS_IN", "TOKENS_OUT", "TOKENS_TOTAL", "RETRIES"
        for (i = 1; i <= nm; i++) { k = rml[i]; split(k, q, "|")
          d = cell("rm", k, 1); if (d != "n/a") sub(/^[0-9]+/, "&s", d)
          printf "  %-18s %-18s %5d %9s %-16s %-16s %-16s %7s\n", q[1], q[2], C["rm", k], d, cell("rm", k, 2), cell("rm", k, 3), cell("rm", k, 5), cell("rm", k, 4) }
        print ""
        printf "  %-35s %5s %9s %-16s %-16s %-16s %7s\n", "MODEL", "DISP", "DURATION", "TOKENS_IN", "TOKENS_OUT", "TOKENS_TOTAL", "RETRIES"
        for (i = 1; i <= nd; i++) { k = mdl[i]
          d = cell("model", k, 1); if (d != "n/a") sub(/^[0-9]+/, "&s", d)
          printf "  %-35s %5d %9s %-16s %-16s %-16s %7s\n", k, C["model", k], d, cell("model", k, 2), cell("model", k, 3), cell("model", k, 5), cell("model", k, 4) }
        print ""
        d = cell("all", "all", 1); if (d != "n/a") sub(/^[0-9]+/, "&s", d)
        rd = cell("runrec", "all", 1); if (rd != "n/a") sub(/^[0-9]+/, "&s", rd)
        printf "  total over %d dispatch(es): duration %s, tokens in %s, tokens out %s, tokens total %s, retries %s\n", C["all", "all"], d, cell("all", "all", 2), cell("all", "all", 3), cell("all", "all", 5), cell("all", "all", 4)
        printf "  total over %d finished run(s): duration %s, delegations %s, fix rounds %s\n", C["runrec", "all"] + 0, rd, cell("runrec", "all", 2), cell("runrec", "all", 3)
      }
      print ""
      print "RECURRING FAILURES (2 or more occurrences; suggestions are not applied)"
      if (po == 0) print "  none found"
      for (i = 1; i <= po; i++) { x = pord[ordk[i]]
        printf "  %d. %s x%d: %s\n     runs: %s\n     suggestion: %s\n", i, pk[x], pc[x], ps[x], pr[x], pg[x] }
      print ""
      print "Sources: the metrics records, each run LEDGER.log and the gate records and results it binds. Control-plane refusals"
      print "(a blocked scope check, a refused approval phrase) leave no record, so only what a ledger or finding states is counted."
    }
  '
  # A202: the size of the text loaded into every session, from the same script doctor and the budget test use
  if [ "$in_json" = 0 ] && [ -z "$in_run" ]; then
    printf '\n'; sh "$PL_HOME/bin/lib/context-size.sh" project "$ROOT" report || :
    if [ -f "$ROOT/.agents/scripts/rules.sh" ]; then printf '\n'; (cd "$ROOT" && sh "$A" rules report) || :; fi
  fi
}
