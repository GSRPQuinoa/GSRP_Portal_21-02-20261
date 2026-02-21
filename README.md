# GSRP Portal (Updated)

This build resolves Discord IDs in **all forms** and logs them as:

`<@ID> (ServerNickname)`

It works with raw IDs and mentions like `<@123>` / `<@!123>` and supports multiple IDs in one field.

## Setup (local)

1. Install dependencies:
   - `npm install`

2. Create your env file:
   - Copy `.env.example` to `.env` and fill in values.

3. Run:
   - `npm start`

Open: `http://localhost:3000`

> Note: sessions are configured to use secure cookies in production only. Local dev works over http.

## Deployment notes

- Set `NODE_ENV=production`
- Ensure your Discord bot has **Server Members Intent** enabled if you want reliable nickname lookups.

## GitHub repo tips

- Do **not** commit your `.env` (it is ignored by `.gitignore`).
