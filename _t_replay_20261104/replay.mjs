import fs from 'node:fs';
import path from 'node:path';
import { auditClarifyNeed, auditDepartmentCoverage, resolvePronounAntecedentInline } from '../lib/understanding.js';

const dir = '/Users/open/Documents/Stocks/_t5_model_validation_20261103/inputs';
const files = fs.readdirSync(dir).filter(f => /^T05-\d+\.txt$/.test(f)).sort();
const plan = { stages: [{ id: 'S1', subtasks: [
  { id: 'S1-1', department: 'research', title: '调研' },
  { id: 'S1-2', department: 'engineering', title: '实现' },
  { id: 'S1-3', department: 'qa', title: '回归' },
] }] };
const out = [];
for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8').trim();
  const clarify = auditClarifyNeed(text, '');
  let cov = null;
  try { cov = auditDepartmentCoverage(text, plan); } catch (e) { cov = { error: String(e && e.message) }; }
  const ant = /它/.test(text) ? resolvePronounAntecedentInline('它', text) : null;
  out.push({ case: f.replace('.txt',''), text, clarify, required: cov && cov.required ? cov.required.map(r => r.department) : null, missing: cov && cov.missing ? cov.missing.map(r => r.department) : null, antecedent: ant });
}
fs.mkdirSync('_t_replay_20261104', { recursive: true });
fs.writeFileSync('_t_replay_20261104/replay_results.json', JSON.stringify(out, null, 2));
const clar = out.filter(o => o.clarify && o.clarify.needed).map(o => o.case + ':' + o.clarify.rule);
console.log('cases=' + out.length, 'clarify=' + clar.length, JSON.stringify(clar));
const normal = out.filter(o => !(o.clarify && o.clarify.needed));
console.log('normal=' + normal.length, 'falseBlock=' + normal.filter(o => o.clarify && o.clarify.needed).length);
const t12 = out.find(o => o.case === 'T05-12');
console.log('T05-12 required=' + JSON.stringify(t12.required), 'missing=' + JSON.stringify(t12.missing));
const t8 = out.find(o => o.case === 'T05-08');
console.log('T05-08 antecedent=' + JSON.stringify(t8.antecedent) + ' clarify=' + JSON.stringify(t8.clarify && t8.clarify.rule));
