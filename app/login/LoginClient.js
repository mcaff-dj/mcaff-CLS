'use client';

import { useEffect } from 'react';

export default function LoginPage() {
  useEffect(() => {
    var params = new URLSearchParams(location.search);
    var next = params.get('next') || '/';
    document.getElementById('signInBtn').href = '/api/auth/login?next=' + encodeURIComponent(next);
    if (params.get('denied') === '1') {
      var e = document.getElementById('err');
      e.style.display = 'block';
      e.textContent = 'You do not have access yet. Ask your admin to grant it, then sign in again.';
    }
  }, []);

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Customer Query Segment Reports</h1>
        <p>Sign in with your Google account to view the reports you&apos;ve been granted access to.</p>
        <a className="g-btn" id="signInBtn" href="#">
          <svg viewBox="0 0 48 48">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z" />
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 18.9 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4c-7.7 0-14.3 4.4-17.7 10.7z" />
            <path fill="#4CAF50" d="M24 44c5.5 0 10.5-2.1 14.3-5.6l-6.6-5.6C29.6 34.7 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.6 39.5 16.2 44 24 44z" />
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.2 5.8l6.6 5.6C41.9 36.8 44 31.1 44 24c0-1.3-.1-2.7-.4-3.5z" />
          </svg>
          Sign in with Google
        </a>
        <div className="err" id="err" style={{ display: 'none' }}></div>
      </div>
    </div>
  );
}
