import Database from 'better-sqlite3'
import { mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { localAgentDir } from '../paths.js'
import type { PersistedMessage } from '../llm/persisted.js'

const DB_FILE = 'sessions.db'

function dbPath(cwd: string): string {
  return join(localAgentDir(cwd), DB_FILE)
}

function openDb(cwd: string): Database.Database {
  const p = dbPath(cwd)
  const db = new Database(p)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  ensureSchema(db)
  return db
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cwd TEXT NOT NULL,
      summary TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS session_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      seq INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
      content,
      content='session_messages',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS session_messages_ai AFTER INSERT ON session_messages BEGIN
      INSERT INTO session_messages_fts(rowid, content)
        VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS session_messages_ad AFTER DELETE ON session_messages BEGIN
      INSERT INTO session_messages_fts(session_messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
    END;
  `)
}

function extractTextContent(messages: PersistedMessage[]): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = []
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant' && m.content?.trim()) {
      out.push({ role: 'assistant', content: m.content })
    }
  }
  return out
}

function generateSummary(messages: PersistedMessage[]): string {
  const userMsgs = messages
    .filter((m): m is Extract<PersistedMessage, { role: 'user' }> => m.role === 'user')
    .slice(0, 3)
    .map((m) => m.content.slice(0, 100))
  return userMsgs.join(' | ') || '(无摘要)'
}

export async function archiveSession(
  cwd: string,
  messages: PersistedMessage[],
): Promise<number> {
  if (!messages.length) return -1
  await mkdir(dirname(dbPath(cwd)), { recursive: true })
  const db = openDb(cwd)
  try {
    const insertSession = db.prepare(
      `INSERT INTO sessions (cwd, summary, message_count) VALUES (?, ?, ?)`
    )
    const insertMsg = db.prepare(
      `INSERT INTO session_messages (session_id, role, content, seq) VALUES (?, ?, ?, ?)`
    )

    const summary = generateSummary(messages)
    const texts = extractTextContent(messages)

    const sessionId = db.transaction(() => {
      const info = insertSession.run(cwd, summary, messages.length)
      const sid = info.lastInsertRowid as number
      for (let i = 0; i < texts.length; i++) {
        const t = texts[i]!
        insertMsg.run(sid, t.role, t.content, i)
      }
      return sid
    })()

    return sessionId
  } finally {
    db.close()
  }
}

export type SearchResult = {
  sessionId: number
  role: string
  snippet: string
  sessionSummary: string
  sessionDate: string
  rank: number
}

export async function searchSessions(
  cwd: string,
  query: string,
  limit: number = 10,
): Promise<SearchResult[]> {
  await mkdir(dirname(dbPath(cwd)), { recursive: true })
  const db = openDb(cwd)
  try {
    const ftsQuery = query
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w.replace(/"/g, '""')}"`)
      .join(' AND ')

    if (!ftsQuery) return []

    const stmt = db.prepare(`
      SELECT
        sm.session_id AS sessionId,
        sm.role,
        snippet(session_messages_fts, 0, '>>>', '<<<', '…', 48) AS snippet,
        s.summary AS sessionSummary,
        s.created_at AS sessionDate,
        rank
      FROM session_messages_fts
      JOIN session_messages sm ON sm.id = session_messages_fts.rowid
      JOIN sessions s ON s.id = sm.session_id
      WHERE session_messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `)

    return stmt.all(ftsQuery, limit) as SearchResult[]
  } finally {
    db.close()
  }
}
