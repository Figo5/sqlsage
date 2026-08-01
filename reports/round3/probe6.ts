import { q01 } from './q01.ts';
import { renderReport } from '../../src/report/index.ts';
const out = renderReport(q01, { format: 'terminal', color: false });
console.log(out.split('\n').slice(0, 27).join('\n'));
console.log('\n=== where does the coupling note live? ===');
out.split('\n').forEach((l, i) => { if (/companion|does nothing alone|1\.04|113\.3/.test(l)) console.log('  line ' + (i+1) + '/' + out.split('\n').length + ': ' + l.trim().slice(0,110)); });
console.log('\n=== unterminated bold markers in markdown ===');
const md = renderReport(q01, { format: 'markdown' });
md.split('\n').forEach((l) => { const n = (l.match(/\*\*/g) ?? []).length; if (n % 2) console.log('  ODD ** count: ' + l.slice(0, 120)); });
