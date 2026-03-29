# Lead Response Accelerator (Prototype)

Turn raw lead CSV exports into:
- a prioritized follow-up queue (`followup-queue.csv`)
- pre-written first-touch messages per lead
- summary metrics (`followup-summary.json`)

## Why
Fast first response usually lifts conversion. This script removes manual triage and gives a ready-to-send queue in minutes.

## Input CSV columns (recommended)
- `name`
- `email`
- `phone` or `whatsapp`
- `utm_source`
- `utm_medium`
- `utm_campaign`
- `interactionMs`

## Run
```bash
node generate-followups.js ./sample-leads.csv ./output
```

## Output
- `output/followup-queue.csv`
- `output/followup-summary.json`

## Notes
- Heuristic scoring only (HOT/WARM/COLD bands)
- No external APIs required
- Safe for local/offline use
