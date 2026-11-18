import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

const API = import.meta.env.VITE_API_URL || ''

async function request(path, options = {}, authToken = '') {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}), ...options.headers },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || 'Something went wrong. Please try again.')
  return data
}

function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location is not available in this browser.'))
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lon: coords.longitude, accuracy: coords.accuracy }),
      (error) => reject(new Error(error.code === 1 ? 'Allow location access to continue.' : 'Location is unavailable. On a phone, open the app over HTTPS and allow location access.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    )
  })
}

function App() {
  const [mode, setMode] = useState('teacher')
  const [className, setClassName] = useState('')
  const [teacherToken, setTeacherToken] = useState(() => sessionStorage.getItem('campuspass.teacherToken') || '')
  const [teacherUsername, setTeacherUsername] = useState(() => sessionStorage.getItem('campuspass.teacherName') || '')
  const [teacherLoginForm, setTeacherLoginForm] = useState({ username: '', password: '' })
  const [session, setSession] = useState(null)
  const [attendees, setAttendees] = useState([])
  const [attendanceQr, setAttendanceQr] = useState(null)
  const [attendanceQrSeconds, setAttendanceQrSeconds] = useState(0)
  const [studentId, setStudentId] = useState('')
  const [qrInput, setQrInput] = useState('')
  const [scanOn, setScanOn] = useState(false)
  const [scanPurpose, setScanPurpose] = useState('attendance')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [remaining, setRemaining] = useState(0)
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const scannerRef = useRef(null)

  const [visitor, setVisitor] = useState({ fullName: '', phone: '', email: '', organization: '', hostName: '', hostDepartment: '', purpose: '', vehicleNumber: '' })
  const [visitorPassId, setVisitorPassId] = useState(() => sessionStorage.getItem('campuspass.visitorPass') || '')
  const [identityVerified, setIdentityVerified] = useState(false)
  const [showEmergency, setShowEmergency] = useState(false)
  const [emergencySearch, setEmergencySearch] = useState('')
  const [visitorPass, setVisitorPass] = useState(null)
  const [visitorQr, setVisitorQr] = useState(null)
  const [visitorQrSeconds, setVisitorQrSeconds] = useState(0)
  const [securityToken, setSecurityToken] = useState(() => sessionStorage.getItem('campuspass.securityToken') || '')
  const [guardUsername, setGuardUsername] = useState(() => sessionStorage.getItem('campuspass.guardName') || '')
  const [login, setLogin] = useState({ username: '', password: '' })
  const [securityData, setSecurityData] = useState({ inside: [], insideCount: 0, recentEvents: [], approvalQueue: [] })

  const loadAttendees = useCallback(async (token) => {
    try {
      const data = await request(`/api/attendance/${encodeURIComponent(token)}/records`, {}, teacherToken)
      setAttendees(data.records || [])
    } catch { /* the session can expire while this screen remains open */ }
  }, [teacherToken])

  const loadSecurityDashboard = useCallback(async (token) => {
    try {
      const data = await request('/api/security/dashboard', {}, token)
      setSecurityData(data)
    } catch (error) {
      if (error.message.includes('login expired')) {
        sessionStorage.removeItem('campuspass.securityToken')
        sessionStorage.removeItem('campuspass.guardName')
        setSecurityToken(''); setGuardUsername('')
      }
    }
  }, [])

  useEffect(() => {
    if (!session) return undefined
    const update = () => setRemaining(Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000)))
    update()
    const timer = window.setInterval(update, 1000)
    const refresh = window.setInterval(() => loadAttendees(session.token), 5000)
    return () => { window.clearInterval(timer); window.clearInterval(refresh) }
  }, [session, loadAttendees])

  useEffect(() => {
    if (!session?.token) return undefined
    let active = true
    const refresh = async () => {
      try {
        const data = await request(`/api/attendance/${encodeURIComponent(session.token)}/qr`)
        if (active) setAttendanceQr(data)
      } catch { if (active) setAttendanceQr(null) }
    }
    const initial = window.setTimeout(refresh, 0)
    const timer = window.setInterval(refresh, 10000)
    return () => { active = false; window.clearTimeout(initial); window.clearInterval(timer) }
  }, [session?.token])

  useEffect(() => {
    if (!attendanceQr?.rotatesAt) return undefined
    const tick = () => setAttendanceQrSeconds(Math.max(0, Math.ceil((attendanceQr.rotatesAt - Date.now()) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [attendanceQr])

  useEffect(() => {
    if (!securityToken) return undefined
    const initial = window.setTimeout(() => loadSecurityDashboard(securityToken), 0)
    const timer = window.setInterval(() => loadSecurityDashboard(securityToken), 5000)
    return () => { window.clearTimeout(initial); window.clearInterval(timer) }
  }, [securityToken, loadSecurityDashboard])

  useEffect(() => {
    if (!visitorPassId) return undefined
    let active = true
    const refresh = async () => {
      try {
        const data = await request(`/api/visitors/${encodeURIComponent(visitorPassId)}/qr`)
        if (active) { setVisitorQr(data); setVisitorPass(data.visitor) }
      } catch (error) { if (active) setMessage({ type: 'error', text: error.message }) }
    }
    refresh()
    const timer = window.setInterval(refresh, 10000)
    return () => { active = false; window.clearInterval(timer) }
  }, [visitorPassId])

  useEffect(() => {
    if (!visitorQr?.rotatesAt) return undefined
    const tick = () => setVisitorQrSeconds(Math.max(0, Math.ceil((visitorQr.rotatesAt - Date.now()) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [visitorQr])

  const stopCamera = useCallback(() => {
    scannerRef.current?.stop()
    scannerRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    videoRef.current?.srcObject?.getTracks?.().forEach((track) => track.stop())
    streamRef.current = null
    setScanOn(false)
  }, [])

  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), [])

  const scanVisitorQr = useCallback(async (payload) => {
    setBusy(true); setMessage(null)
    let location = {}
    try { location = await getLocation() } catch { /* gate scans remain available if GPS is blocked */ }
    try {
      const data = await request('/api/security/scan', { method: 'POST', body: JSON.stringify({ payload, latitude: location.lat, longitude: location.lon, identityVerified }) }, securityToken)
      setMessage({ type: 'success', text: `${data.message} ${data.visitor.fullName} · ${data.visitor.purpose}` })
      await loadSecurityDashboard(securityToken)
    } catch (error) { setMessage({ type: 'error', text: error.message }) }
    finally { setBusy(false); setIdentityVerified(false) }
  }, [securityToken, loadSecurityDashboard, identityVerified])

  useEffect(() => {
    if (!scanOn || !videoRef.current) return undefined
    let active = true
    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires HTTPS.')
        const { BrowserCodeReader, BrowserQRCodeReader } = await import('@zxing/browser')
        await BrowserCodeReader.listVideoInputDevices()
        const reader = new BrowserQRCodeReader()
        const controls = await reader.decodeFromVideoDevice(undefined, videoRef.current, (result) => {
          if (!result || !active) return
          const rawValue = result.getText()
          if (scanPurpose === 'visitor') void scanVisitorQr(rawValue)
          else {
            setQrInput(rawValue)
            setMessage({ type: 'success', text: 'QR code captured. Enter your student ID and check in.' })
          }
          stopCamera()
        })
        if (!active) controls.stop()
        else scannerRef.current = controls
      } catch {
        setMessage({ type: 'error', text: 'Could not open the camera. Use HTTPS, allow camera access, or paste the QR code text.' })
        stopCamera()
      }
    }
    start()
    return () => { active = false; scannerRef.current?.stop(); scannerRef.current = null }
  }, [scanOn, scanPurpose, stopCamera, scanVisitorQr])

  async function startAttendance(event) {
    event.preventDefault(); setBusy(true); setMessage(null)
    try {
      const location = await getLocation()
      const data = await request('/api/attendance/start', { method: 'POST', body: JSON.stringify({ teacherLat: location.lat, teacherLon: location.lon, teacherAccuracy: location.accuracy, className: className.trim() }) }, teacherToken)
      setSession(data); setAttendees([]); setAttendanceQr(null)
      setMessage({ type: 'success', text: 'Attendance is open. Students can scan this QR code now.' })
    } catch (error) { setMessage({ type: 'error', text: error.message }) }
    finally { setBusy(false) }
  }

  async function teacherLogin(event) {
    event.preventDefault(); setBusy(true); setMessage(null)
    try {
      const data = await request('/api/teacher/login', { method: 'POST', body: JSON.stringify(teacherLoginForm) })
      sessionStorage.setItem('campuspass.teacherToken', data.token); sessionStorage.setItem('campuspass.teacherName', data.username)
      setTeacherToken(data.token); setTeacherUsername(data.username); setTeacherLoginForm({ username: '', password: '' })
      setMessage({ type: 'success', text: `Signed in as ${data.username}.` })
    } catch (error) { setMessage({ type: 'error', text: error.message }) }
    finally { setBusy(false) }
  }

  async function teacherLogout() {
    try { await request('/api/teacher/logout', { method: 'POST' }, teacherToken) } catch { /* local sign-out still completes */ }
    sessionStorage.removeItem('campuspass.teacherToken'); sessionStorage.removeItem('campuspass.teacherName')
    setTeacherToken(''); setTeacherUsername(''); setSession(null); setAttendees([])
  }

  async function downloadSessionAttendance() {
    if (!session?.token) return
    try {
      const response = await fetch(`${API}/api/teacher/attendance/${encodeURIComponent(session.token)}.csv`, { headers: { Authorization: `Bearer ${teacherToken}` } })
      if (!response.ok) throw new Error('Could not download this session attendance.')
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'campuspass-session-attendance.csv'; anchor.click(); URL.revokeObjectURL(url)
    } catch (error) { setMessage({ type: 'error', text: error.message }) }
  }

  async function markAttendance(event) {
    event.preventDefault(); setBusy(true); setMessage(null)
    try {
      const payload = qrInput.trim()
      if (!payload) throw new Error('Scan a current CampusPass QR code or paste its contents.')
      const location = await getLocation()
      const data = await request('/api/attendance/verify', { method: 'POST', body: JSON.stringify({ payload, studentId: studentId.trim(), studentLat: location.lat, studentLon: location.lon, studentAccuracy: location.accuracy }) })
      setMessage({ type: 'success', text: `${data.message} Estimated distance: ${data.distance} m. GPS accuracy is included.` })
      setQrInput('')
    } catch (error) { setMessage({ type: 'error', text: error.message }) }
    finally { setBusy(false) }
  }

  async function createVisitorPass(event) {
    event.preventDefault(); setBusy(true); setMessage(null)
    try {
      const data = await request('/api/visitors', { method: 'POST', body: JSON.stringify(visitor) })
      sessionStorage.setItem('campuspass.visitorPass', data.passId)
      setVisitorPassId(data.passId)
      setMessage({ type: 'success', text: 'Request sent to campus security. Your rotating QR activates after approval.' })
    } catch (error) { setMessage({ type: 'error', text: error.message }) }
    finally { setBusy(false) }
  }

  async function decideSecurityApproval(passId, decision) {
    setBusy(true); setMessage(null)
    try {
      await request(`/api/security/visitor-approvals/${encodeURIComponent(passId)}`, { method: 'POST', body: JSON.stringify({ decision }) }, securityToken)
      setMessage({ type: 'success', text: decision === 'approved' ? 'Visitor approved. Their pass is now active.' : 'Visitor request declined.' })
      await loadSecurityDashboard(securityToken)
    } catch (error) { setMessage({ type: 'error', text: error.message }) }
    finally { setBusy(false) }
  }

  async function securityLogin(event) {
    event.preventDefault(); setBusy(true); setMessage(null)
    try {
      const data = await request('/api/security/login', { method: 'POST', body: JSON.stringify(login) })
      sessionStorage.setItem('campuspass.securityToken', data.token)
      sessionStorage.setItem('campuspass.guardName', data.username)
      setSecurityToken(data.token); setGuardUsername(data.username); setLogin({ username: '', password: '' })
      setMessage({ type: 'success', text: `Signed in as ${data.username}.` })
    } catch (error) { setMessage({ type: 'error', text: error.message }) }
    finally { setBusy(false) }
  }

  async function securityLogout() {
    try { await request('/api/security/logout', { method: 'POST' }, securityToken) } catch { /* local sign-out still completes */ }
    sessionStorage.removeItem('campuspass.securityToken'); sessionStorage.removeItem('campuspass.guardName')
    setSecurityToken(''); setGuardUsername(''); setSecurityData({ inside: [], insideCount: 0, recentEvents: [] })
  }

  async function downloadVisitorLog() {
    try {
      const response = await fetch(`${API}/api/security/events.csv`, { headers: { Authorization: `Bearer ${securityToken}` } })
      if (!response.ok) throw new Error('Could not download the visitor log.')
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'campuspass-visitor-log.csv'; anchor.click(); URL.revokeObjectURL(url)
    } catch (error) { setMessage({ type: 'error', text: error.message }) }
  }


  async function downloadAttendanceLog() {
    try {
      const response = await fetch(API + '/api/security/attendance.csv', { headers: { Authorization: 'Bearer ' + securityToken } })
      if (!response.ok) throw new Error('Could not download the attendance log.')
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'campuspass-attendance.csv'; anchor.click(); URL.revokeObjectURL(url)
    } catch (error) { setMessage({ type: 'error', text: error.message }) }
  }

  const emergencyTerm = emergencySearch.trim().toLowerCase()
  const filteredStudents = (securityData.presentStudents || []).filter((row) => [row.className, row.teacherName, row.studentId].join(' ').toLowerCase().includes(emergencyTerm))
  const filteredInside = (securityData.inside || []).filter((row) => [row.fullName, row.organization, row.hostName].join(' ').toLowerCase().includes(emergencyTerm))

  const expired = session && remaining === 0
  const switchMode = (nextMode) => { stopCamera(); setMode(nextMode); setMessage(null) }
  const modeTitle = { teacher: 'Make every class count.', student: 'You’re one scan away.', visitor: 'Welcome to campus.', security: 'A safer campus starts here.' }
  const modeSubtitle = { teacher: 'Sign in to start a secure class session and manage attendance.', student: 'Scan your class QR code to check in securely.', visitor: 'Register your visit and get your secure, rotating pass.', security: securityToken ? 'Manage campus entry with a live visitor log.' : 'Sign in to scan visitor passes and manage campus entry.' }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="CampusPass home"><span className="brand-mark">C</span><span>campus<span className="brand-light">pass</span></span></a>
        <nav className="mode-switch" aria-label="Choose CampusPass service">
          <button className={mode === 'teacher' || mode === 'student' ? 'active' : ''} onClick={() => switchMode('teacher')}>Attendance</button>
          <button className={mode === 'visitor' ? 'active' : ''} onClick={() => switchMode('visitor')}>Visitor</button>
          <button className={mode === 'security' ? 'active' : ''} onClick={() => switchMode('security')}>Security</button>
        </nav>
        <div className="secure-label"><span className="secure-dot" /> Secure campus access</div>
      </header>

      <main id="home">
        <section className="welcome-row">
          <div><div className="eyebrow">CAMPUSPASS · SMART CAMPUS ACCESS</div><h1>{modeTitle[mode]}</h1><p>{modeSubtitle[mode]}</p></div>
          <div className="welcome-icon" aria-hidden="true">{mode === 'security' ? '◈' : mode === 'visitor' ? '⌖' : mode === 'student' ? '▦' : '✳'}</div>
        </section>

        {message && <div className={`notice ${message.type}`} role="status"><span>{message.type === 'success' ? '✓' : '!'}</span>{message.text}<button aria-label="Dismiss" onClick={() => setMessage(null)}>×</button></div>}

        {mode === 'teacher' && <>
          <div className="submode-tabs"><button className={mode === 'teacher' ? 'active' : ''} onClick={() => setMode('teacher')}>Teacher</button><button onClick={() => switchMode('student')}>Student check-in</button></div>
          {teacherToken ? <>
          <div className="security-dashboard-header teacher-header"><div><div className="eyebrow">FACULTY WORKSPACE</div><h2>Welcome, {teacherUsername}</h2><p>Start a five-minute check-in and export its complete class roster.</p></div><button className="secondary-button" onClick={teacherLogout}>Sign out</button></div>
          <section className="teacher-grid">
            <div className="card setup-card">
              <div className="card-heading"><span className="step-number">01</span><div><h2>Set up your session</h2><p>Share a few details to get started.</p></div></div>
              <form onSubmit={startAttendance}>
                <label htmlFor="class-name">Class or subject</label><input id="class-name" value={className} onChange={(e) => setClassName(e.target.value)} placeholder="e.g. Biology · Room 204" required />
                <div className="location-note"><span>◎</span><div><strong>Your location anchors this session</strong><small>GPS accuracy is included in the 50 metre check.</small></div></div>
                <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Getting your location…' : '↗  Start attendance'}</button>
              </form>
            </div>
            <div className="card live-card">
              {session ? <>
                <div className="card-heading"><span className={`live-indicator ${expired ? 'ended' : ''}`} /><div><h2>{expired ? 'Session ended' : 'Session is live'}</h2><p>{session.className || className || 'Class attendance'}</p></div><span className="timer">{expired ? '00:00' : `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`}</span></div>
                {session.teacherName && <div className="session-teacher">Hosted by {session.teacherName}</div>}
                <div className="qr-wrap">{!expired && (attendanceQr?.qrCode ? <img src={attendanceQr.qrCode} alt="Rotating attendance QR code" /> : <div className="qr-placeholder">▦</div>)}<div className="qr-caption">{expired ? 'Start a new session to generate another code.' : `Code refreshes in ${attendanceQrSeconds}s`}</div>{!expired && attendanceQr?.payload && <button className="same-device-button" onClick={() => { setQrInput(attendanceQr.payload); setMode('student'); setMessage({ type: 'success', text: 'Current session code is ready. Enter your student ID to check in on this device.' }) }}>Check in on this device</button>}</div>
                <div className="session-meta"><span>⌖  50 m radius + GPS accuracy</span><span>◷  5 minute session</span></div>
                <button className="secondary-button session-export-button" onClick={downloadSessionAttendance}>⇩ Download this session’s student attendance CSV</button>
              </> : <div className="empty-session"><div className="qr-placeholder">▦</div><h2>Your QR code appears here</h2><p>Start an attendance session to create a secure, time-limited check-in code.</p><div className="session-meta"><span>⌖  50 m location check</span><span>◷  5 minute session</span></div></div>}
            </div>
            <div className="card roster-card">
              <div className="roster-heading"><div><div className="eyebrow">LIVE ROSTER</div><h2>Class check-ins</h2></div><span className="count-pill">{attendees.length} present</span></div>
              {attendees.length ? <div className="roster-list">{attendees.map((person) => <div className="roster-person" key={person.studentId}><span className="avatar">{person.studentId.slice(0, 1).toUpperCase()}</span><strong>{person.studentId}</strong><span>{new Date(person.markedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><b>✓</b></div>)}</div> : <div className="roster-empty">{session ? 'Waiting for students to check in…' : 'Your student check-ins will appear here.'}</div>}
            </div>
          </section>
          </> : <section className="security-login-layout teacher-login-layout"><div className="card security-login-card"><div className="security-lock">✳</div><div className="eyebrow">FACULTY ACCESS</div><h2>Teacher sign in</h2><p>Sign in to start a class session and download its attendance roster.</p><form onSubmit={teacherLogin}><label htmlFor="teacher-user">Username</label><input id="teacher-user" autoComplete="username" value={teacherLoginForm.username} onChange={(e) => setTeacherLoginForm({ ...teacherLoginForm, username: e.target.value })} required /><label htmlFor="teacher-password">Password</label><input id="teacher-password" type="password" autoComplete="current-password" value={teacherLoginForm.password} onChange={(e) => setTeacherLoginForm({ ...teacherLoginForm, password: e.target.value })} required /><button className="primary-button" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in as teacher'}</button></form></div><aside className="card how-card"><div className="eyebrow">FIVE MINUTE SESSION</div><h2>One class, one attendance file.</h2><p>Every valid student check-in during the session appears together in the teacher’s downloadable roster.</p></aside></section>}
        </>}

        {mode === 'student' && <section className="student-layout">
          <div className="card student-card">
            <div className="card-heading"><span className="step-number">01</span><div><h2>Scan your class QR</h2><p>Point your camera at the code shown by your teacher.</p></div></div>
            {scanOn && scanPurpose === 'attendance' ? <div className="camera-box"><video ref={videoRef} playsInline muted /><div className="scan-frame" /><button className="camera-close" onClick={stopCamera}>Close camera</button></div> : <button type="button" className="scan-button" onClick={() => { setMessage(null); setScanPurpose('attendance'); setScanOn(true) }}><span className="scan-symbol">▦</span><span><strong>Open camera to scan</strong><small>Allow camera access when prompted</small></span><b>→</b></button>}
            <div className="or-divider"><span /> or enter QR code <span /></div>
            <form onSubmit={markAttendance}><label htmlFor="qr-code">QR code text</label><textarea id="qr-code" rows="2" value={qrInput} onChange={(e) => setQrInput(e.target.value)} placeholder="Paste the code text here" /><label htmlFor="student-id">Student ID</label><input id="student-id" value={studentId} onChange={(e) => setStudentId(e.target.value)} placeholder="e.g. STU2024012" required /><div className="location-note"><span>◎</span><div><strong>Location is checked when you submit</strong><small>Be in class and allow location access.</small></div></div><button className="primary-button" type="submit" disabled={busy || !studentId.trim()}>{busy ? 'Checking location…' : '✓  Mark my attendance'}</button></form>
          </div>
          <aside className="card how-card"><div className="how-icon">✳</div><div className="eyebrow">QUICK CHECK-IN</div><h2>Simple, secure, in the room.</h2><p>Your attendance is recorded only after the QR code and your location are verified.</p><ol><li><span>1</span>Scan the code your teacher shares</li><li><span>2</span>Enter your student ID</li><li><span>3</span>Allow location to confirm check-in</li></ol><div className="privacy-note">⌖ &nbsp; GPS uncertainty is considered.</div></aside>
        </section>}

        {mode === 'visitor' && <section className="visitor-layout">
          {!visitorPassId ? <div className="card visitor-form-card">
            <div className="card-heading"><span className="step-number">01</span><div><h2>Visitor registration</h2><p>Enter your details to create your campus pass.</p></div></div>
            <form className="visitor-form" onSubmit={createVisitorPass}>
              <label htmlFor="visitor-name">Full name</label><input id="visitor-name" value={visitor.fullName} onChange={(e) => setVisitor({ ...visitor, fullName: e.target.value })} placeholder="Name as shown on your ID" autoComplete="name" required />
              <div className="form-two"><div><label htmlFor="visitor-phone">Phone number</label><input id="visitor-phone" type="tel" value={visitor.phone} onChange={(e) => setVisitor({ ...visitor, phone: e.target.value })} placeholder="+91 98765 43210" autoComplete="tel" required /></div><div><label htmlFor="visitor-email">Email address</label><input id="visitor-email" type="email" value={visitor.email} onChange={(e) => setVisitor({ ...visitor, email: e.target.value })} placeholder="you@example.com" autoComplete="email" required /></div></div>
              <div className="form-two"><div><label htmlFor="visitor-org">Organization</label><input id="visitor-org" value={visitor.organization} onChange={(e) => setVisitor({ ...visitor, organization: e.target.value })} placeholder="Company or institution" required /></div><div><label htmlFor="visitor-vehicle">Vehicle number <span>OPTIONAL</span></label><input id="visitor-vehicle" value={visitor.vehicleNumber} onChange={(e) => setVisitor({ ...visitor, vehicleNumber: e.target.value.toUpperCase() })} placeholder="e.g. KA 01 AB 1234" /></div></div>
              <div className="form-two"><div><label htmlFor="host-name">Person you are meeting</label><input id="host-name" value={visitor.hostName} onChange={(e) => setVisitor({ ...visitor, hostName: e.target.value })} placeholder="Host name" required /></div><div><label htmlFor="host-dept">Department / office</label><input id="host-dept" value={visitor.hostDepartment} onChange={(e) => setVisitor({ ...visitor, hostDepartment: e.target.value })} placeholder="e.g. Admissions" required /></div></div>
              <label htmlFor="visit-purpose">Purpose of visit</label><textarea id="visit-purpose" rows="3" value={visitor.purpose} onChange={(e) => setVisitor({ ...visitor, purpose: e.target.value })} placeholder="Briefly describe your visit" required />
              <div className="location-note"><span>◈</span><div><strong>Your visitor pass lasts 12 hours</strong><small>Security scans it to check you in and out.</small></div></div>
              <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Creating your pass…' : 'Create my visitor pass'}</button>
            </form>
          </div> : <div className="card visitor-pass-card">
            <div className="pass-status-row"><div><div className="eyebrow">YOUR CAMPUSPASS</div><h2>Visitor pass</h2></div><span className={`status-pill ${visitorPass?.status === 'inside' ? 'inside' : ''}`}>{visitorPass?.approvalStatus === 'pending' ? 'Security approval pending' : visitorPass?.approvalStatus === 'denied' ? 'Request declined' : visitorPass?.status === 'inside' ? 'On campus' : 'Ready for entry'}</span></div>
            <div className="visitor-pass-content">{visitorQr?.qrCode ? <div className="visitor-qr-wrap"><img src={visitorQr.qrCode} alt="Rotating visitor QR code" /><span>Code refreshes in {visitorQrSeconds}s</span></div> : visitorPass?.approvalStatus === 'pending' ? <div className="approval-pending"><span className="qr-placeholder">◷</span><strong>Waiting for security approval</strong><small>Campus security reviews your visit request. Your live QR will appear here after approval.</small></div> : visitorPass?.approvalStatus === 'denied' ? <div className="approval-pending"><strong>Visit request declined</strong><small>Contact campus security for next steps.</small></div> : <div className="qr-placeholder">▦</div>}
              <div className="visitor-pass-info"><h3>{visitorPass?.fullName || visitor.fullName}</h3><p>{visitorPass?.organization || visitor.organization}</p><div className="pass-detail"><span>MEETING</span><strong>{visitorPass?.hostName || visitor.hostName}</strong><small>{visitorPass?.hostDepartment || visitor.hostDepartment}</small></div><div className="pass-detail"><span>PURPOSE</span><strong>{visitorPass?.purpose || visitor.purpose}</strong></div>{(visitorPass?.vehicleNumber || visitor.vehicleNumber) && <div className="pass-detail"><span>VEHICLE</span><strong>{visitorPass?.vehicleNumber || visitor.vehicleNumber}</strong></div>}<div className="pass-detail"><span>PASS VALID FOR</span><strong>12 hours from registration</strong></div></div>
            </div><div className="privacy-note">Show the live code to security at entry. When leaving, show the refreshed code again so the guard can record your exit.</div>
          </div>}
          <aside className="card how-card visitor-how"><div className="how-icon">◈</div><div className="eyebrow">VISITOR ACCESS</div><h2>A smooth arrival, from gate to host.</h2><p>Your pass keeps your visit details together for the security team.</p><ol><li><span>1</span>Register your details and host</li><li><span>2</span>Wait for security to approve your request</li><li><span>3</span>Show your QR at entry, then again at exit</li></ol><div className="privacy-note">⌖ &nbsp; The pass stays active for 12 hours.</div></aside>
        </section>}

        {mode === 'security' && (!securityToken ? <section className="security-login-layout">
          <div className="card security-login-card"><div className="security-lock">◈</div><div className="eyebrow">CAMPUS SECURITY</div><h2>Security sign in</h2><p>Use your assigned guard account to access visitor check-in.</p><form onSubmit={securityLogin}><label htmlFor="security-user">Username</label><input id="security-user" autoComplete="username" value={login.username} onChange={(e) => setLogin({ ...login, username: e.target.value })} required /><label htmlFor="security-password">Password</label><input id="security-password" type="password" autoComplete="current-password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} required /><button className="primary-button" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in securely'}</button></form><div className="privacy-note">Security accounts are set up by the campus administrator.</div></div>
          <aside className="card how-card"><div className="how-icon">⌖</div><div className="eyebrow">GATE DESK</div><h2>One scan for a clear arrival log.</h2><p>Every scan records the guard, the visitor, and the exact check-in or check-out time.</p><div className="privacy-note">QR codes refresh every 30 seconds to reduce replay.</div></aside>
        </section> : <section className="security-dashboard">
          <div className="security-dashboard-header"><div><div className="eyebrow">LIVE GATE STATUS</div><h2>Welcome, {guardUsername}</h2><p>Visitor access is refreshing automatically.</p></div><div className="security-actions"><button className="secondary-button" onClick={downloadVisitorLog}>⇩ Visitor CSV</button><button className="secondary-button" onClick={downloadAttendanceLog}>⇩ Attendance CSV</button><button className="secondary-button" onClick={() => setShowEmergency((value) => !value)}>Emergency roll call</button><button className="secondary-button" onClick={securityLogout}>Sign out</button></div></div>
          <div className="security-stats"><div className="card stat-card"><span className="stat-icon">⌖</span><div><strong>{securityData.insideCount}</strong><span>Visitors on campus</span></div></div><div className="card stat-card"><span className="stat-icon">◷</span><div><strong>{securityData.attendanceToday || 0}</strong><span>Attendance today</span></div></div><div className="card stat-card"><span className="stat-icon">↗</span><div><strong>{securityData.visitorsToday || 0}</strong><span>Visitor check-ins today</span></div></div><div className="card stat-card"><span className="stat-icon">!</span><div><strong>{securityData.pendingApprovals || 0}</strong><span>Security approvals pending</span></div></div><div className="card scan-launch-card"><div><strong>Gate check-in and exit</strong><span>Scan on arrival; scan again when leaving.</span></div><button className="primary-button" onClick={() => { setIdentityVerified(false); setScanPurpose('visitor'); setScanOn(true) }}>▦ &nbsp; Scan entry or exit</button></div></div>
          {scanOn && scanPurpose === 'visitor' && <div className="card security-camera-card"><label className="id-check"><input type="checkbox" checked={identityVerified} onChange={(event) => setIdentityVerified(event.target.checked)} /> I matched the visitor’s photo ID for entry</label><div className="camera-box"><video ref={videoRef} playsInline muted /><div className="scan-frame" /><button className="camera-close" onClick={stopCamera}>Close scanner</button></div><p>Entry: confirm the photo ID before scanning. Exit: scan the visitor’s refreshed QR code again.</p></div>}
          {!!securityData.approvalQueue?.length && <div className="card security-list-card approval-queue"><div className="roster-heading"><div><div className="eyebrow">VISITOR ACCESS</div><h2>Requests awaiting security approval</h2><p>Review visitor details before activating a pass.</p></div><span className="count-pill">{securityData.approvalQueue.length} pending</span></div><div className="approval-queue-list">{securityData.approvalQueue.map((person) => <article className="approval-request" key={person.passId}><div><strong>{person.fullName}</strong><span>{person.organization} · {person.phone} · {person.email}</span><small>Meeting {person.hostName} · {person.hostDepartment}</small><small>{person.purpose}{person.vehicleNumber ? ` · Vehicle ${person.vehicleNumber}` : ''}</small></div><div className="approval-actions"><button className="primary-button" disabled={busy} onClick={() => decideSecurityApproval(person.passId, 'approved')}>Approve</button><button className="secondary-button" disabled={busy} onClick={() => decideSecurityApproval(person.passId, 'denied')}>Decline</button></div></article>)}</div></div>}
          {showEmergency && <section className="card emergency-roll-call">
            <div className="roster-heading"><div><div className="eyebrow">EMERGENCY VIEW</div><h2>Campus roll call</h2><p>Recorded check-ins for today and visitors currently inside.</p></div><button className="secondary-button" onClick={() => window.print()}>Print roll call</button></div>
            <div className="location-note"><span>!</span><div><strong>{filteredStudents.length} student check-ins · {filteredInside.length} visitors inside</strong><small>Use this as a live record of app check-ins; it does not detect people who have not checked in.</small></div></div>
            <label className="emergency-search-label" htmlFor="emergency-search">Search roll call</label><input id="emergency-search" value={emergencySearch} onChange={(event) => setEmergencySearch(event.target.value)} placeholder="Student, class, visitor or organization" />
            <div className="security-panels emergency-panels"><div className="card security-list-card"><div className="eyebrow">STUDENT ATTENDANCE TODAY</div>{filteredStudents.length ? <div className="event-list">{filteredStudents.map((row, index) => <div className="event-row" key={row.className + row.studentId + row.markedAt + index}><span className="event-mark">✓</span><div><strong>{row.studentId}</strong><span>{row.className} · {row.teacherName || 'Faculty'}</span></div><time>{new Date(row.markedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>)}</div> : <div className="roster-empty">No matching attendance records.</div>}</div>
              <div className="card security-list-card"><div className="eyebrow">VISITORS CURRENTLY INSIDE</div>{filteredInside.length ? <div className="visitor-table">{filteredInside.map((row) => <div className="visitor-row" key={row.passId}><div className="visitor-row-avatar">{row.fullName.slice(0, 1).toUpperCase()}</div><div className="visitor-row-main"><strong>{row.fullName}</strong><span>{row.organization} · Host {row.hostName}</span><small>{row.purpose}</small></div><span className="inside-pill">Inside</span></div>)}</div> : <div className="roster-empty">No matching visitors are inside.</div>}</div></div>
          </section>}
          <div className="security-panels"><div className="card security-list-card"><div className="roster-heading"><div><div className="eyebrow">CURRENTLY INSIDE</div><h2>On-campus visitors</h2></div><span className="count-pill">{securityData.insideCount} inside</span></div>{securityData.inside.length ? <><p className="exit-hint">To record someone leaving, scan their refreshed visitor QR. The same scan records check-out.</p><div className="visitor-table">{securityData.inside.map((person) => <div className="visitor-row" key={person.passId}><div className="visitor-row-avatar">{person.fullName.slice(0, 1).toUpperCase()}</div><div className="visitor-row-main"><strong>{person.fullName}</strong><span>{person.organization} · Meeting {person.hostName}</span><small>{person.purpose}</small></div><div className="visitor-row-side"><strong>{person.vehicleNumber || 'No vehicle'}</strong><span>{person.phone}</span></div><span className="inside-pill">Inside</span></div>)}</div></> : <div className="roster-empty">No visitors are currently checked in.</div>}</div>
            <div className="card security-list-card"><div className="roster-heading"><div><div className="eyebrow">AUDIT TRAIL</div><h2>Recent gate activity</h2></div><span className="count-pill">Live</span></div>{securityData.recentEvents.length ? <div className="event-list">{securityData.recentEvents.map((event) => <div className="event-row" key={event.id}><span className={`event-mark ${event.eventType === 'CHECK_OUT' ? 'out' : ''}`}>{event.eventType === 'CHECK_OUT' ? '↗' : '↙'}</span><div><strong>{event.fullName} <em>{event.eventType === 'CHECK_OUT' ? 'checked out' : 'checked in'}</em></strong><span>{event.organization} · {event.guardUsername}{event.identityVerified ? ' · Photo ID matched' : ''}</span></div><time>{new Date(event.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>)}</div> : <div className="roster-empty">Scanned entries and exits will appear here.</div>}</div></div>
        </section>)}
      </main>
      <footer><span>© CampusPass</span><span>Attendance and visitor access, together.</span><span><i /> Secure campus access</span></footer>
    </div>
  )
}

export default App


