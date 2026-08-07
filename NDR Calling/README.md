# RTO CRM Tool

Web queue for agents to action orders that are RTO per both courier (column N) and logistics (column Q) in the tracking sheet, and write back the replacement order's New Order Id / AWB / Status (columns T/U/V).

## Setup

1. `npm install`
2. Copy `.env.local.example` to `.env.local` and fill in:
   - `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY` — from your Google Cloud service account JSON key.
   - `GOOGLE_SHEET_ID` — the ID in the sheet's URL (`.../d/<this part>/edit`).
   - `GOOGLE_SHEET_TAB` — the tab name to read/write (currently `HYPHEN`).
3. Share the Google Sheet with the service account's `client_email` as **Editor** (Share button → paste email → Editor).
4. `npm run dev`, open http://localhost:3000

## Deploy to Vercel

1. Push this repo to GitHub (or `vercel` CLI directly).
2. Import the repo in Vercel.
3. In Project Settings → Environment Variables, add the same 4 vars from `.env.local` (paste `GOOGLE_PRIVATE_KEY` with the `\n` literals intact, keep the quotes out — Vercel stores it as a raw string).
4. Deploy.

## How it works

- `/api/orders` reads the sheet and returns rows where `Status as per AWB` (N) and `Update from Logistics front` (Q) both contain "RTO" (case-insensitive) and `Status` (V) is still blank.
- Agents fill in New Order Id / AWB / Status per row and hit Save; `/api/orders/update` writes those 3 fields back into columns T/U/V for that exact row.
- Once V is filled, the row drops out of the queue on next load — no separate database, the Sheet is the only store.

## Security note

The service account private key is a live credential. Never commit `.env.local`. If it's ever exposed (pasted somewhere, committed by accident), rotate it immediately in Google Cloud Console → IAM & Admin → Service Accounts → Keys.
