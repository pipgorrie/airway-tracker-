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
info) is stored in the browser's `localStorage`, on-device only. The site owner
never receives anyone's data.

- `storage.js` — a small shim that replaces the Claude.ai-artifact-only
  `window.storage` API with a `localStorage`-backed equivalent.
- `backup.js` — full backup/restore (.json), automatic backup to a chosen file
  (Chrome/Edge), CSV import, backup reminders, install prompt, and a request
  for persistent storage.
- `sw.js` + `manifest.webmanifest` — installable app with offline support.
  Installing matters on iPhone/iPad: Safari can erase a non-installed site's
  storage after 7 days without a visit.
- `sync.js` — optional sync through each user's own Google Drive,
  end-to-end encrypted with their passphrase (see below).

## Google Drive sync setup

Sync stays hidden until `GOOGLE_CLIENT_ID` in `sync.js` is filled in.

1. Go to https://console.cloud.google.com/ and create a project (e.g. "Airway Tracker").
2. **APIs & Services → Library**: enable the **Google Drive API**.
3. **Google Auth Platform → Branding** (OAuth consent screen): app name, support
   email, and the app's home page `https://airway-tracker.vercel.app`.
   Audience: **External**.
4. **Data access**: add the scope `https://www.googleapis.com/auth/drive.file`
   (non-sensitive — the app can only see files it created).
5. **Clients → Create client**: type **Web application**. Authorized JavaScript
   origins: `https://airway-tracker.vercel.app` and `http://localhost:8420`.
   No redirect URIs are needed.
6. Copy the client ID (ends in `.apps.googleusercontent.com`) into
   `GOOGLE_CLIENT_ID` in `sync.js`.
7. While the app is in **Testing**, only Google accounts added under
   **Audience → Test users** (up to 100) can sign in. **Publish** the app to
   open it to everyone; Google may ask to verify the app's branding first.

The synced file is encrypted (PBKDF2-SHA256 600k → AES-256-GCM) before upload;
the passphrase never leaves the device and a forgotten passphrase can't be
recovered.

## Disclaimer

This is a personal tracking tool, not a medical device. It doesn't diagnose
or treat any condition. Always follow your ENT or pulmonologist's guidance,
and seek urgent care for sudden or severe breathing difficulty.
