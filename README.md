# CampusPass

CampusPass combines class attendance and visitor gate management in one mobile friendly app.

## Local setup

Use Node.js 24 or newer. In one terminal, set the security and teacher accounts and start the API:

```powershell
$env:SECURITY_USERNAME = "campus-security"
$env:SECURITY_PASSWORD = "choose-a-long-unique-password"
$env:TEACHER_USERNAME = "your-teacher-username"
$env:TEACHER_PASSWORD = "choose-a-strong-teacher-password"
$env:ADMIN_USERNAME = "your-admin-username"
$env:ADMIN_PASSWORD = "choose-a-strong-admin-password"
npm run server
```

In another terminal, run `npm run dev` and open the local URL shown by Vite. The Vite server proxies API calls to the computer running the API. The SQLite database is created at `data/campuspass.sqlite` and is excluded from Git.

Phone camera and location access require HTTPS. Use the deployed Render HTTPS address or a trusted HTTPS development tunnel, and allow camera and location permissions. The QR scanner uses the back camera where available.

## Features

- Teachers sign in with the `TEACHER_USERNAME` and `TEACHER_PASSWORD` settings, start a five minute class check-in session, and download the complete roster for that session as one CSV. The classroom QR rotates every 30 seconds and is signed by the server.
- Students scan from a different phone or paste the current QR text, enter their student ID, and check in once. GPS accuracy is included to account for indoor drift. Teachers see a live roster.
- Each check-in submits one student ID. A browser device key can only be paired with one student ID per attendance session, and a student ID can only be used once in that session. This prevents changing IDs on the same browser during a class session; identity ownership still requires a registered student login to verify independently.
- Visitors submit their full name, phone, email, organization, vehicle number, host, department, and visit purpose. A security guard reviews the request in the security dashboard; the rotating pass activates only after security approves it.
- Visitor passes rotate every 30 seconds. Security scans the live QR at entry and scans a refreshed QR at exit. Entry requires a photo ID match, and each event records the guard, timestamp, ID confirmation, and optional GPS location.
- Security staff sign in with a provisioned account, review visitor approvals, see daily attendance and visitor counts, live occupancy, and gate activity, and export visitor and attendance logs as CSV. The searchable emergency roll call lists today's recorded student check-ins and visitors currently inside, with a print view.
- Head/admin accounts see unique student IDs recorded, visitor passes issued, today's distinct student check-ins, currently checked-in visitors, open class sessions, pending visitor approvals, and recent attendance and gate activity. Recorded campus presence combines today's student check-ins and visitors still marked inside; student check-outs are not tracked.
- Visitor details, gate events, attendance sessions, and attendance records are stored in SQLite.

## Deploy to Render Free

The `render.yaml` file configures a free Node web service, Node 24, HTTPS hosting, and an automatically generated security password. The app uses SQLite by default. Render Free has an ephemeral filesystem, so attendance records, visitor passes, and security events may be erased when the service sleeps, restarts, or redeploys. Use this setup for demos only; persistent records require a paid persistent disk or migration to a managed database.

Push the project to GitHub, then create a Render Blueprint from the repository. After deployment, retrieve the generated `SECURITY_PASSWORD` from the service environment settings and share it only with authorized security staff.

