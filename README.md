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

- Teachers sign in with the `TEACHER_USERNAME` and `TEACHER_PASSWORD` settings, enter their display name and class for each five minute check-in session, and download that session's attendance CSV. They can also load a 15 or 30 day report for that teacher and class, see each recorded student’s attended sessions and percentage, export one dated CSV with a Present/Absent column per session, and share the CSV through their phone’s share menu (including a parents’ group). Students who have never checked in are not listed because CampusPass does not yet have a class roster to identify them.
- Students scan from a different phone or paste the current QR text, enter their student ID, and check in once. The scanner uses the back camera, shorter decode intervals, and a lower-resolution preview for quicker reads; a zoom control appears when the phone camera supports hardware zoom. GPS accuracy is included to account for indoor drift. Teachers see a live roster.
- Each check-in submits one student ID. A browser device key can only be paired with one student ID per attendance session, and a student ID can only be used once in that session. This prevents changing IDs on the same browser during a class session; identity ownership still requires a registered student login to verify independently.
- Visitors submit their full name, phone, email, organization, vehicle number, host, department, and visit purpose. A security guard reviews the request in the security dashboard; the rotating pass activates only after security approves it.
- Visitor passes rotate every 30 seconds. Security scans the live QR at entry and scans a refreshed QR at exit. Entry requires a photo ID match, and each event records the guard, timestamp, ID confirmation, and optional GPS location.
- Security staff sign in with a provisioned account, review visitor approvals, see daily attendance and visitor counts, live occupancy, and gate activity, and export visitor and attendance logs as CSV. The searchable emergency roll call lists today's recorded student check-ins and visitors currently inside, with a print view.
- Head/admin accounts see unique student IDs recorded, visitor passes issued, today's distinct student check-ins, currently checked-in visitors, open class sessions, pending visitor approvals, and recent attendance and gate activity. Recorded campus presence combines today's student check-ins and visitors still marked inside; student check-outs are not tracked.
- The admin Campus Assistant answers questions about today's student check-ins, visitors inside, pending approvals, active attendance sessions, and the daily summary using fixed, predefined SQLite queries. It does not create SQL from questions and does not use an AI model.
- During an active emergency, students can submit a self-reported safety confirmation. Security sees each confirmation separately from students who checked in today but have not confirmed, plus visitors currently inside. A student ID entered by a student is not independently verified, and attendance check-ins are not a complete campus roster.
- Visitor details, gate events, attendance sessions, and attendance records are stored in SQLite.

## Deploy to Render Free

The `render.yaml` file configures a free Node web service, Node 24, HTTPS hosting, and generated passwords for security, admin, and teacher accounts. Account usernames are `campus-security`, `campus-admin`, and `campus-teacher` in this Blueprint. Production passwords belong in the Render service's Environment settings and must not be committed to this repository. The live Render service has a separate database and credentials from your computer.

The app uses SQLite by default. The current free Render service has no persistent disk configured, and Render Free web services lose local filesystem changes on restart or deploy. That can erase attendance records, visitor passes, and gate events. Persistent disks require a paid web service. For long-term production storage, a managed PostgreSQL database is a better fit, but CampusPass currently uses SQLite and needs a deliberate schema and data migration before switching; do not change `DATABASE_PATH` to a PostgreSQL URL. Render's free Postgres option expires after 30 days, so it is not a permanent production store.

The health check is `/api/health`. The Vite development server proxies `/api` to `http://127.0.0.1:5000`; in production, Express serves both the API and built frontend from the same service. The Render Blueprint does not pin a Git branch. Check the Render service's dashboard to confirm its connected branch and auto-deploy setting.

Push the project to GitHub, then create a Render Blueprint from the repository. After deployment, retrieve the generated `SECURITY_PASSWORD` from the service environment settings and share it only with authorized security staff.
