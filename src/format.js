const codes = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90, bold: 1 };

function painter(color) {
  return (style, s) => (color ? `\x1b[${codes[style]}m${s}\x1b[0m` : s);
}

function plural(n, word) {
  if (n === 1) return `1 ${word}`;
  if (/[^aeiou]y$/.test(word)) return `${n} ${word.slice(0, -1)}ies`;
  return `${n} ${/(s|sh|ch|x)$/.test(word) ? `${word}es` : `${word}s`}`;
}

function compact(v, max = 100) {
  const s = JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

export function formatTrace(trace, { color = false } = {}) {
  const c = painter(color);
  const width = Math.max(...trace.map((s) => s.tx.length));
  return trace.map((s, i) => {
    const n = String(i + 1).padStart(2);
    const who = s.tx.padEnd(width);
    if (s.type === 'retry') return `  ${c('gray', n)}  ${who} │ ${c('yellow', `↻ ${s.op}`)}`;
    let text = s.type === 'unblock' ? `↳ ${s.op}` : s.op;
    let tail = '';
    if (s.blockedBy && s.type === 'send') tail = c('yellow', `  ⏳ waits for ${s.blockedBy.join(', ')}`);
    else if (s.error) tail = c('red', `  ✗ ${s.error.message}${s.error.code ? ` (${s.error.code})` : ''}`);
    else if (s.result) tail = c('green', `  → ${s.result}`);
    if (s.type === 'unblock' && !s.error) tail += c('gray', '  (unblocked)');
    const style = /^(COMMIT|ROLLBACK)$/.test(s.op) ? 'magenta' : 'cyan';
    if (s.type === 'unblock') text = c('yellow', text);
    else text = c(style, text);
    return `  ${c('gray', n)}  ${who} │ ${text}${tail}`;
  }).join('\n');
}

function verdictText(lr, c, retries = 0) {
  const scope = lr.complete ? `${lr.schedules} (all)` : `${lr.schedules} (sampled)`;
  let result;
  if (lr.verdict === 'unsafe') {
    const parts = [];
    if (lr.invariantFailures) parts.push(`${lr.invariantFailures} of ${lr.schedules} break the invariant`);
    if (lr.anomalies) parts.push(`${lr.anomalies} of ${lr.schedules} match no serial order`);
    result = `${c('red', '✗ UNSAFE')}  ${parts.join(', ')}`;
  } else if (lr.verdict === 'retry') {
    const msg = retries
      ? `${lr.aborts} of ${lr.schedules} still abort after ${plural(retries, 'retry')}`
      : `${lr.aborts} of ${lr.schedules} abort a transaction (40001/40P01): retry it in your code`;
    result = `${c('green', '✓ safe')}    ${c('yellow', msg)}`;
  } else {
    result = `${c('green', '✓ safe')}`;
    if (lr.retried) result += `    ${c('gray', `${lr.retried} of ${lr.schedules} needed a retry`)}`;
  }
  return { scope, result };
}

function outcomeText(name, o) {
  if (o.kind === 'committed') return `${name} committed${o.value !== undefined ? ` → ${compact(o.value, 60)}` : ''}`;
  if (o.kind === 'aborted') return `${name} aborted (${o.error?.code ?? 'retryable'})`;
  return `${name} failed: ${o.error?.message}`;
}

function diffTables(got, serial) {
  const exp = JSON.parse(serial.state);
  const tables = [...new Set([...Object.keys(got), ...Object.keys(exp)])];
  return tables.filter((t) => JSON.stringify(got[t]) !== JSON.stringify(exp[t]));
}

export function formatReport(report, { color = false } = {}) {
  const c = painter(color);
  const out = [];
  out.push(`${c('bold', 'sqlloom')} · ${plural(report.transactions.length, 'transaction')} (${report.transactions.join(', ')})`);
  out.push('');
  const rows = report.levels.map((lr) => ({ lr, ...verdictText(lr, c, report.retries) }));
  out.push(c('gray', `  ${'isolation level'.padEnd(18)}${'schedules'.padEnd(16)}result`));
  for (const { lr, scope, result } of rows) {
    const mark = report.level === lr.level ? c('bold', ' ◂ yours') : '';
    out.push(`  ${lr.level.padEnd(18)}${scope.padEnd(16)}${result}${mark}`);
  }
  for (const w of report.warnings ?? []) out.push(`\n${c('yellow', '⚠')} ${w}`);

  const shown = new Map();
  for (const lr of report.levels) {
    if (!lr.worst) continue;
    const w = lr.worst;
    out.push('');
    const why = w.problem.kind === 'invariant'
      ? `invariant failed: ${w.problem.message}`
      : 'the result matches no serial order of the transactions';
    const key = JSON.stringify([w.trace, why]);
    if (shown.has(key)) {
      out.push(`${c('red', '✗')} ${c('bold', lr.level)}: ${why} — same interleaving as ${shown.get(key)}`);
      continue;
    }
    shown.set(key, lr.level);
    out.push(`${c('red', '✗')} ${c('bold', lr.level)}: ${why}`);
    out.push(c('gray', `  Shortest interleaving (${plural(w.switches, 'context switch')}, replay "${w.replay}"):`));
    out.push('');
    out.push(formatTrace(w.trace, { color }));
    out.push('');
    out.push(`  ${Object.entries(w.outcomes).map(([n, o]) => outcomeText(n, o)).join(' · ')}`);
    if (w.problem.kind === 'anomaly') {
      const closest = w.problem.serial[0];
      const tables = diffTables(w.state, closest);
      for (const t of tables.length ? tables : Object.keys(w.state)) out.push(`  ${t}: ${compact(w.state[t])}`);
      for (const s of w.problem.serial) {
        const exp = JSON.parse(s.state);
        const shown = (tables.length ? tables : Object.keys(exp)).map((t) => `${t}: ${compact(exp[t])}`).join(' ');
        const outs = Object.entries(s.outcomes).map(([n, o]) => outcomeText(n, o)).join(' · ');
        out.push(c('gray', `  serial ${s.order.join(' → ')}: ${shown}${outs ? ` · ${outs}` : ''}`));
      }
    } else {
      for (const [t, rowsOf] of Object.entries(w.state)) out.push(`  ${t}: ${compact(rowsOf)}`);
    }
  }
  return out.join('\n');
}
