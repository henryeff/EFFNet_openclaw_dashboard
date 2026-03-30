const fs = require('fs');

const audience = ['First-time buyers', 'HDB upgraders', 'Investors'];
const offers = [
  'Free 15-min affordability check',
  'Latest new launch shortlist in 24h',
  'Price negotiation playbook PDF',
  'ROI hotspot map + analyst notes',
];
const ctas = ['Get My Plan', 'Show Me My Options', 'Send Me The Shortlist', 'Unlock My Report'];

function score({ audience, offer, cta }) {
  let s = 50;
  if (/Free|Latest|ROI/.test(offer)) s += 12;
  if (/My/.test(cta)) s += 8;
  if (/Investors/.test(audience) && /ROI|Price/.test(offer)) s += 10;
  if (/First-time/.test(audience) && /affordability/.test(offer)) s += 10;
  return Math.min(95, s);
}

const tests = [];
for (const a of audience) {
  for (const o of offers) {
    for (const c of ctas) {
      const confidence = score({ audience: a, offer: o, cta: c });
      const estLift = ((confidence - 45) / 3).toFixed(1);
      tests.push({
        audience: a,
        headline: `${a}: ${o}`,
        cta: c,
        confidence,
        estimatedLiftPct: Number(estLift),
      });
    }
  }
}

const ranked = tests.sort((x, y) => y.confidence - x.confidence).slice(0, 20);
fs.writeFileSync(require('path').join(__dirname, 'lead-offer-tests.json'), JSON.stringify(ranked, null, 2));
console.log('Generated', ranked.length, 'ranked tests -> prototypes/lead-capture-offer-lab/lead-offer-tests.json');
