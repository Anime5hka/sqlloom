// Renders the real output of `sqlloom examples/on-call.mjs` as an animated terminal SVG.
// Usage: SQLLOOM_URL=... node scripts/demo-svg.js > assets/demo.svg
import { check, formatReport } from '../src/index.js';
import onCall from '../examples/on-call.mjs';

const report = await check({ ...onCall, level: 'read committed' });
const text = formatReport(report, { color: true });

const palette = { 1: null, 31: '#ff7b72', 32: '#7ee787', 33: '#e3b341', 34: '#79c0ff', 35: '#d2a8ff', 36: '#79c0ff', 90: '#8b949e' };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function spans(line) {
  const out = [];
  let style = null;
  for (const part of line.split(/(\x1b\[\d+m)/)) {
    const m = part.match(/^\x1b\[(\d+)m$/);
    if (m) { style = m[1] === '0' ? null : m[1]; continue; }
    if (!part) continue;
    if (!style) out.push(esc(part));
    else if (style === '1') out.push(`<tspan font-weight="700" fill="#f0f6fc">${esc(part)}</tspan>`);
    else out.push(`<tspan fill="${palette[style]}">${esc(part)}</tspan>`);
  }
  return out.join('');
}

const lines = ['\x1b[90m$\x1b[0m npx sqlloom examples/on-call.mjs', '', ...text.split('\n')];
const lh = 20;
const top = 52;
const width = 1000;
const height = top + lines.length * lh + 16;
const rows = lines.map((l, i) => {
  const delay = i < 2 ? i * 0.3 : 0.9 + (i - 2) * 0.12;
  return `<text x="20" y="${top + i * lh}" class="l" style="animation-delay:${delay.toFixed(2)}s" xml:space="preserve">${spans(l)}</text>`;
}).join('\n  ');

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="sqlloom output: a write-skew race found at read committed and repeatable read, safe at serializable">
<style>
  .l { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; fill: #c9d1d9; opacity: 0; animation: in .25s ease-out forwards; }
  @keyframes in { to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .l { animation: none; opacity: 1; } }
</style>
<rect width="${width}" height="${height}" rx="10" fill="#0d1117"/>
<rect width="${width}" height="30" rx="10" fill="#161b22"/>
<rect y="20" width="${width}" height="10" fill="#161b22"/>
<circle cx="20" cy="15" r="6" fill="#ff5f56"/><circle cx="40" cy="15" r="6" fill="#ffbd2e"/><circle cx="60" cy="15" r="6" fill="#27c93f"/>
  ${rows}
</svg>
`);
