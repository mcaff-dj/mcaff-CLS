"""CRM-PEP's own tiny user store - just who's allowed in and who's an admin.
SQLite (stdlib only, no new dependency, no shared infra) since this app owns nothing
else: lead data lives in the Google Sheet (see rto_sheet.py), never mirrored here.
"""
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "crm_pep.db"


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_conn()
    conn.execute(
        """CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            name TEXT,
            is_admin INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )"""
    )
    conn.commit()
    conn.close()


def upsert_user(email, name, admin_emails):
    """Creates the user on first login (or updates their name), and promotes them to
    admin if their email is in ADMIN_EMAILS - never demotes, so removing an email from
    ADMIN_EMAILS later doesn't silently strip an admin who was already granted it."""
    email = email.lower()
    is_admin = 1 if email in admin_emails else 0
    conn = get_conn()
    conn.execute(
        """INSERT INTO users (email, name, is_admin) VALUES (?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET
             name = excluded.name,
             is_admin = MAX(users.is_admin, excluded.is_admin)""",
        (email, name, is_admin),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()
    return dict(row)


def list_agents():
    conn = get_conn()
    rows = conn.execute("SELECT email, name, is_admin FROM users ORDER BY email ASC").fetchall()
    conn.close()
    return [dict(r) for r in rows]
