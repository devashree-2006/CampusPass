# CampusPass

CampusPass combines class attendance and visitor gate management in one mobile friendly app.

## Local setup

Use Node.js 24 or newer. In one terminal, set the security account and start the API:

```powershell
$env:SECURITY_USERNAME = "campus-security"
$env:SECURITY_PASSWORD = "choose-a-long-unique-password"
npm run server
```

In another terminal, run `npm run dev` and open the local URL shown by Vite. The Vite server proxies API calls to the computer running the API. The SQLite database is created at `data/campuspass.sqlite` and is excluded from Git.

Phone camera and location access require HTTPS. Use the deployed Render HTTPS address or a trusted HTTPS development tunnel, and allow camera and location permissions. The QR scanner uses the back camera where available.

## Features

- Teachers start a class session with a five minute check-in window and 50 metre location check. The classroom QR rotates every 30 seconds and is signed by the server.
- Students scan from a different phone or paste the current QR text, enter their student ID, and check in once. GPS accuracy is included to account for indoor drift. Teachers see a live roster.
- Visitors submit their full name, phone, email, organization, vehicle number, host, department, and visit purpose. The host gets a one-use approval link; the rotating pass activates only after approval.
- Visitor passes rotate every 30 seconds. Guard scans check visitors in or out, reject stale or reused codes, require a photo ID match before check-in, and record the guard, timestamp, ID confirmation, and optional GPS location.
- Security staff sign in with a provisioned account, see daily attendance and visitor counts, pending approvals, live occupancy, and gate activity, and export visitor and attendance logs as CSV. The searchable emergency roll call lists today's recorded student check-ins and visitors currently inside, with a print view.
- Visitor details, gate events, attendance sessions, and attendance records are stored in SQLite.

## Deploy to Render Free

The `render.yaml` file configures a free Node web service, Node 24, HTTPS hosting, and an automatically generated security password. The app uses SQLite by default. Render Free has an ephemeral filesystem, so attendance records, visitor passes, and security events may be erased when the service sleeps, restarts, or redeploys. Use this setup for demos only; persistent records require a paid persistent disk or migration to a managed database.

Push the project to GitHub, then create a Render Blueprint from the repository. After deployment, retrieve the generated `SECURITY_PASSWORD` from the service environment settings and share it only with authorized security staff.

