# Airway Stenosis Tracking

A personal tracking tool for airway stenosis — peak flow, SpO₂, symptoms,
surgeries, treatments, documents, and care team contacts. Originally built as
a Claude.ai artifact; this is a standalone version that runs as a static site.

## Run it

```
npm run dev
```

Then open http://localhost:8420 in your browser.

(Port 8420 was picked because 3000 was already in use on this machine — edit
the port in `package.json` if you'd like a different one.)

(No dependencies required — `npm run dev` just runs `python3 -m http.server`.
Any static file server works, e.g. `npx serve .`.)

## Data storage

All data (readings, symptoms, surgeries, treatments, documents, care team
info) is stored in the browser's `localStorage`, on-device only. Nothing is
sent anywhere.

`storage.js` is a small shim that replaces the Claude.ai-artifact-only
`window.storage` API with a `localStorage`-backed equivalent, so the app runs
as a normal static site.

**Backups**: use Settings → "Export my data (.json)" regularly, since
`localStorage` is tied to this browser/device and can be cleared by clearing
browser data.

## Disclaimer

This is a personal tracking tool, not a medical device. It doesn't diagnose
or treat any condition. Always follow your ENT or pulmonologist's guidance,
and seek urgent care for sudden or severe breathing difficulty.
