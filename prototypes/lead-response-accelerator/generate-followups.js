#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];

  const headers = splitLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = splitLine(line);
    const row = {};
    headers.forEach((header, i) => {
      row[header] = (values[i] || '').trim();
    });
    return row;
  });
}

function splitLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }

    cur += ch;
  }

  out.push(cur);
  return out;
}

function scoreLead(lead) {
  let score = 50;
  const medium = (lead.utm_medium || '').toLowerCase();
  const source = (lead.utm_source || '').toLowerCase();
  const campaign = (lead.utm_campaign || '').toLowerCase();
  const interaction = Number(lead.interactionMs || 0);

  if (interaction >= 5000) score += 15;
  else if (interaction >= 2500) score += 8;

  if (medium.includes('cpc') || medium.includes('paid')) score += 20;
  if (source.includes('google') || source.includes('facebook') || source.includes('tiktok')) score += 8;
  if (campaign.includes('condo') || campaign.includes('valuation') || campaign.includes('upgrade')) score += 10;

  if (!lead.phone && !lead.whatsapp) score -= 10;
  if (!lead.name) score -= 5;

  return Math.max(0, Math.min(100, score));
}

function band(score) {
  if (score >= 80) return 'HOT';
  if (score >= 60) return 'WARM';
  return 'COLD';
}

function renderMessage(lead, scoreBand) {
  const name = lead.name || 'there';
  const campaign = lead.utm_campaign || 'your property plans';

  if (scoreBand === 'HOT') {
    return `Hi ${name}, thanks for your interest in ${campaign}. I can share 2 quick options that typically save buyers 20-40k in negotiation. Want a fast breakdown today?`;
  }

  if (scoreBand === 'WARM') {
    return `Hi ${name}, thanks for reaching out. I prepared a short guide for ${campaign} with current market moves and next-step checklist. Want me to send it here?`;
  }

  return `Hi ${name}, thanks for connecting. If useful, I can send a simple Singapore property starter checklist based on your timeline and budget.`;
}

function main() {
  const inputPath = process.argv[2];
  const outputDir = process.argv[3] || path.join(process.cwd(), 'output');

  if (!inputPath) {
    console.error('Usage: node generate-followups.js <leads.csv> [outputDir]');
    process.exit(1);
  }

  const raw = fs.readFileSync(inputPath, 'utf8');
  const leads = parseCsv(raw);
  fs.mkdirSync(outputDir, { recursive: true });

  const enriched = leads.map((lead) => {
    const score = scoreLead(lead);
    const scoreBand = band(score);
    const message = renderMessage(lead, scoreBand);
    return { ...lead, score, scoreBand, message };
  }).sort((a, b) => b.score - a.score);

  const queueCsvLines = [
    ['priority', 'score', 'scoreBand', 'name', 'email', 'phone', 'utm_source', 'utm_medium', 'utm_campaign', 'message'].join(','),
    ...enriched.map((lead, i) => [
      i + 1,
      lead.score,
      lead.scoreBand,
      csvEscape(lead.name || ''),
      csvEscape(lead.email || ''),
      csvEscape(lead.phone || lead.whatsapp || ''),
      csvEscape(lead.utm_source || ''),
      csvEscape(lead.utm_medium || ''),
      csvEscape(lead.utm_campaign || ''),
      csvEscape(lead.message || ''),
    ].join(',')),
  ];

  const summary = {
    totalLeads: enriched.length,
    hot: enriched.filter((l) => l.scoreBand === 'HOT').length,
    warm: enriched.filter((l) => l.scoreBand === 'WARM').length,
    cold: enriched.filter((l) => l.scoreBand === 'COLD').length,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(outputDir, 'followup-queue.csv'), queueCsvLines.join('\n'));
  fs.writeFileSync(path.join(outputDir, 'followup-summary.json'), JSON.stringify(summary, null, 2));

  console.log('Done. Outputs:');
  console.log(`- ${path.join(outputDir, 'followup-queue.csv')}`);
  console.log(`- ${path.join(outputDir, 'followup-summary.json')}`);
  console.log('Summary:', summary);
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

main();
