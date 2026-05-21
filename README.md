# cd11-primary-results-2026-public

Public results map for the CA-11 primary on **June 2, 2026**. Neutral branding, no campaign affiliation visible. Modeled loosely on [electionmapsf.com/2024-11-05](https://electionmapsf.com/2024-11-05).

Hosted at: **TBD on GitHub Pages from the `docs/` directory.** The repo is private; the published static site is public.

## What's here
```
docs/
├── index.html                  # main page
├── css/style.css               # neutral styling, no campaign palette
├── js/map.js                   # Leaflet map + side panel
├── data/                       # populated by the internal repo's publish workflow
└── assets/candidate-photos/    # neutral candidate headshots
```

## What this site does NOT show

Per locked decision (build plan §7d):
- No model predictions or deltas.
- No "expected" values, no campaign branding.
- No CVR vs. SOV discrepancy badges.
- No "% of precincts reporting" (use ballots-counted only).
- No VBM vs. Election Day split — combined display.
- No internal strategic flags.

## Default view

**Race leader** (precinct colored by whoever is winning it). Side panel on click shows full candidate breakdown with photos and one-line bios.

## Toggle granularity

- Precinct (default after Report 4)
- Supervisor district (aggregated)
- All CD-11 (single fill)

## Early-night state (Reports 1–3, ~8:45pm–10:45pm June 2)

- Grayed-out CD-11 outline. No precinct fill colors yet.
- Citywide preliminary totals above the map.
- Banner: "Precinct-level data expected with Report 4 (approximately midnight)."

## Certification

When `sov.xlsx` + a certification letter appear in the SF DoE feed, the banner flips from PRELIMINARY to CERTIFIED FINAL automatically.

## Data source

All numbers are derived from SF DoE machine-readable releases — specifically the CVR (Cast Vote Record). The internal pipeline (separate private repo) parses the CVR after each drop and pushes a public-safe JSON slice to `docs/data/`.
