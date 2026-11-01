# SPDX-License-Identifier: MPL-2.0
#
# Issue #1293 — stream filter for the query index gate
# (docs/dev/query-index-gate.md). Postgres runs with auto_explain logging
# the plan of every statement and log_line_prefix '@@%a@@ ', so every log
# message starts with "@@<application_name>@@" and its plan lines follow
# unprefixed. The full log of an integration run is gigabytes; this keeps
# only the plans that
#   (a) ran inside a Database Adapter transaction (tag "caelo/<holder>",
#       packages/query-api/src/statement-tag.ts), and
#   (b) scan a relation without an index condition: a Seq Scan, or an
#       Index (Only) Scan with a Filter but no Index Cond — the planner
#       walking a whole index for its order, which reads every row just
#       the same,
# with costs, durations, parameters and output lists removed so repeats of
# the same plan collapse to one entry. Each kept entry ends with "@@END".
#
# awk, not a Bun script: it sits on the server's log stream, and a reader
# slower than the server would slow every statement of the run.
#
# The server's logging collector writes the log into a FIFO this reads
# (`awk … <> fifo`): the collector reassembles each message, so plans of
# concurrent backends never interleave the way they do on a plain stderr
# pipe once a message exceeds PIPE_BUF. Opened read-write, the FIFO never
# reports EOF, so the last entry is flushed by the next message — the gate
# job logs one after the run. With -v stats=<file>, the running count of
# raw log bytes read is written there every 50 MB, for the job's summary.

{
  total += length($0) + 1
  if (stats != "" && total >= next_stat) {
    printf "%d bytes of server log read\n", total > stats
    close(stats)
    next_stat = total + 50000000
  }
}

function indent_of(s) {
  return match(s, /[^ \t]/) - 1
}

# Close the Index (Only) Scan node being read, if any.
function end_index_node() {
  if (in_index && !index_cond && index_filter) full_index = 1
  in_index = 0
}

function flush() {
  end_index_node()
  if (keep && (buf ~ /Seq Scan on / || full_index)) {
    if (!(buf in seen)) {
      seen[buf] = 1
      print buf
      print "@@END"
      fflush()
    }
  }
  buf = ""
  keep = 0
  full_index = 0
}

/^@@/ {
  flush()
  if (index($0, "@@caelo/") == 1) {
    keep = 1
    line = $0
    sub(/duration: [0-9.]+ ms */, "", line)
    buf = line
  }
  next
}

keep {
  if ($0 ~ /^[ \t]*(Output|Query Identifier|Query Parameters|Buffers|Planning|Execution):/) next
  g = $0
  gsub(/ *\(cost=[^)]*\)/, "", g)
  buf = buf "\n" g
  if (in_index) {
    if (indent_of(g) <= node_indent || g ~ /->/) end_index_node()
    else if (g ~ /^[ \t]*Index Cond:/) index_cond = 1
    else if (g ~ /^[ \t]*Filter:/) index_filter = 1
  }
  if (g ~ /Index (Only )?Scan (Backward )?using /) {
    in_index = 1
    node_indent = indent_of(g)
    index_cond = 0
    index_filter = 0
  }
}

END { flush() }
