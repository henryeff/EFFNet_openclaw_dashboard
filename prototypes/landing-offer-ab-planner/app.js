function dollars(n) {
  return new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD', maximumFractionDigits: 0 }).format(n);
}

function renderPlan() {
  const visitors = Number(document.getElementById('visitors').value || 0);
  const conv = Number(document.getElementById('conv').value || 0) / 100;
  const leadValue = Number(document.getElementById('leadValue').value || 0);
  const uplift = Number(document.getElementById('uplift').value || 0) / 100;

  const currentLeads = visitors * conv;
  const improvedLeads = visitors * conv * (1 + uplift);
  const extraLeads = improvedLeads - currentLeads;

  const currentRevenue = currentLeads * leadValue;
  const projectedRevenue = improvedLeads * leadValue;
  const upside = projectedRevenue - currentRevenue;

  const tests = [
    { test: 'Lead magnet headline rewrite', impact: 5, effort: 2 },
    { test: 'CTA copy + color variant', impact: 4, effort: 1 },
    { test: 'Add trust proof near form', impact: 4, effort: 2 },
    { test: 'Form friction reduction (optional fields)', impact: 3, effort: 1 },
    { test: 'Intent-qualified follow-up routing', impact: 5, effort: 3 },
  ].sort((a, b) => (b.impact / b.effort) - (a.impact / a.effort));

  const result = document.getElementById('result');
  result.innerHTML = `
    <div class="metric">Potential monthly upside: ${dollars(upside)}</div>
    <p class="small">Current: ${dollars(currentRevenue)} → Projected: ${dollars(projectedRevenue)}</p>
    <p><strong>Extra leads/month:</strong> ${extraLeads.toFixed(1)}</p>
    <hr style="border:0;border-top:1px solid #e5e7eb;margin:1rem 0" />
    <p><strong>Priority test order (Impact/Effort):</strong></p>
    <ol>${tests.map((t) => `<li>${t.test} <span class=\"small\">(I:${t.impact} / E:${t.effort})</span></li>`).join('')}</ol>
  `;
}

document.getElementById('run').addEventListener('click', renderPlan);
renderPlan();
