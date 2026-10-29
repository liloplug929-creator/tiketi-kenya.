# Tiketi Kenya by Astrokeed — deployment package

This is a deployable full-stack MVP for a Kenyan event-ticket marketplace. It is more than the original browser-only demo: it includes a server, persistent SQLite database, organizer applications, admin controls, events, M-Pesa Daraja STK Push integration, payment callback handling, paid-ticket codes and QR images, sales/commission reporting, and CSV export.

## Important: what is and is not live

- This package is **not yet a live website**. It must be deployed to a hosting account.
- Real M-Pesa payments cannot work until the owner supplies their own Safaricom Daraja credentials and the correct business shortcode/passkey. Never use another person's credentials.
- Start with Safaricom's **sandbox**. Production payments require Safaricom approval and production credentials.
- Set up the business's refund/ cancellation policy, privacy notice, support email/phone, and organizer payout agreement before taking real customer money.
- Commission is recorded in reports. This version does **not** automatically split M-Pesa funds or send organizer payouts. Those require a separate approved payout process/integration.
- The app uses a simple ticket-per-order code and QR. An event gate/scanner workflow and duplicate-scan prevention are not included yet.
- Email delivery of ticket receipts is not included; the buyer sees the ticket after payment confirmation and can open its ticket details/QR.
- SQLite is persisted on Render's paid persistent disk configuration. Hosting, domain, messaging/email, payment fees, and any business fees may cost money. Do not assume an ongoing zero-cost production service.

## Easiest online hosting path (Android phone or computer)

1. Download and extract this ZIP.
2. Create/sign in to GitHub at https://github.com.
3. Create a **private** repository, for example `tiketi-kenya`.
4. Upload all files and folders from this package to the repository root. Make sure `package.json`, `server.js`, `render.yaml`, and `public/index.html` are at the root / expected paths.
5. Create/sign in to Render at https://render.com.
6. In Render choose **New + → Blueprint** and connect the GitHub repository. Render should read `render.yaml` and create the web service and persistent disk.
7. In the service's Environment settings, set:
   - `BASE_URL` = the exact public Render URL, e.g. `https://your-service.onrender.com` (no trailing slash)
   - `ADMIN_EMAIL` = your admin login email
   - `ADMIN_PASSWORD` = a unique strong password (at least 16 characters recommended)
   - `SESSION_SECRET` = a long random secret (Render can generate one)
   - `MPESA_ENV` = `sandbox` initially
   - `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY` = your own Daraja sandbox credentials
   - `MPESA_TRANSACTION_TYPE` = the transaction type supported by your shortcode
8. Deploy. Open `https://YOUR-APP-URL/api/health`; it should return `{"ok":true,...}`.
9. Open the home page, sign in with the admin email/password you set, approve organizer applications, create/publish a test event, and test the organizer workflow.
10. Test M-Pesa in sandbox using the current instructions/test numbers from Safaricom Daraja. Confirm successful and failed callbacks before accepting any real payments.
11. Only after Safaricom has approved your business for live payments, set `MPESA_ENV=production` and replace every sandbox credential/shortcode/passkey with the matching production values. Confirm that the callback URL uses your final HTTPS domain.

## Safaricom Daraja

Start at https://developer.safaricom.co.ke/ and create your own app/credentials. For live collection, follow Safaricom's current onboarding requirements for your business and shortcode. The `174379` shortcode in the Render template is a common sandbox test shortcode, not your live business shortcode.

## Local run (for a developer)

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env
# Edit .env with a strong session secret, admin credentials, and Daraja sandbox credentials
npm start
```

Open http://localhost:3000. M-Pesa callbacks require a publicly reachable HTTPS URL, so local payment callbacks will not work without a secure tunnel or deployed service.

## Included features

- Public event listing and search
- Organizer registration (pending approval) and sign-in
- Admin approval/rejection of organizers
- Organizer event creation; admin can publish/unpublish/cancel events
- M-Pesa STK Push request and callback handling
- Payment status polling, ticket code, and QR image after confirmed payment
- Admin gross sales, estimated platform commission, order list and CSV export
- Configurable platform commission percentage (0–30%)
- Persistent database and session store on a mounted disk

## Before production launch

Have a qualified developer review the code and security, including rate limiting, CSRF protection, backup/restore, reconciliation against Safaricom transaction records, ticket validation at the door, privacy/data retention, refund and chargeback handling, tax/accounting, and payout agreements. Do not store M-Pesa PINs or ask customers to enter them on this website.
