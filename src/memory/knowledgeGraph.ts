import Database from 'better-sqlite3'
import { mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { localAgentDir } from '../paths.js'

const KG_DB_FILE = 'knowledge.db'

function kgDbPath(cwd: string): string {
  return join(localAgentDir(cwd), KG_DB_FILE)
}

function openKgDb(cwd: string): Database.Database {
  const p = kgDbPath(cwd)
  const db = new Database(p)
  db.pragma('journal_mode = WAL')
  ensureKgSchema(db)
  return db
}

function ensureKgSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS triples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      valid_from TEXT,
      valid_until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject);
    CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object);
    CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate);
  `)
}

export type Triple = {
  id: number
  subject: string
  predicate: string
  object: string
  validFrom: string | null
  validUntil: string | null
  createdAt: string
  source: string | null
}

export type KgAction =
  | { action: 'add'; subject: string; predicate: string; object: string; valid_from?: string; source?: string }
  | { action: 'invalidate'; subject: string; predicate: string; object: string; ended?: string }
  | { action: 'query'; entity: string; as_of?: string }
  | { action: 'timeline'; entity: string }
  | { action: 'stats' }

export async function executeKgAction(
  cwd: string,
  act: KgAction,
): Promise<{ ok: boolean; message?: string; error?: string; results?: unknown }> {
  await mkdir(dirname(kgDbPath(cwd)), { recursive: true })
  const db = openKgDb(cwd)
  try {
    if (act.action === 'stats') {
      const row = db.prepare('SELECT COUNT(*) AS cnt FROM triples').get() as { cnt: number }
      const subjects = db.prepare('SELECT COUNT(DISTINCT subject) AS cnt FROM triples').get() as { cnt: number }
      const predicates = db.prepare('SELECT COUNT(DISTINCT predicate) AS cnt FROM triples').get() as { cnt: number }
      return {
        ok: true,
        results: {
          totalTriples: row.cnt,
          uniqueSubjects: subjects.cnt,
          uniquePredicates: predicates.cnt,
        },
      }
    }

    if (act.action === 'add') {
      if (!act.subject?.trim() || !act.predicate?.trim() || !act.object?.trim()) {
        return { ok: false, error: 'subject、predicate、object 均不能为空' }
      }
      const existing = db.prepare(
        `SELECT id FROM triples
         WHERE subject = ? AND predicate = ? AND object = ?
         AND valid_until IS NULL`
      ).get(act.subject, act.predicate, act.object) as { id: number } | undefined

      if (existing) {
        return { ok: true, message: '该三元组已存在且有效，未重复添加' }
      }

      db.prepare(
        `INSERT INTO triples (subject, predicate, object, valid_from, source)
         VALUES (?, ?, ?, ?, ?)`
      ).run(act.subject, act.predicate, act.object, act.valid_from ?? null, act.source ?? null)
      return { ok: true, message: `已添加: ${act.subject} → ${act.predicate} → ${act.object}` }
    }

    if (act.action === 'invalidate') {
      if (!act.subject?.trim() || !act.predicate?.trim() || !act.object?.trim()) {
        return { ok: false, error: 'subject、predicate、object 均不能为空' }
      }
      const ended = act.ended ?? new Date().toISOString()
      const info = db.prepare(
        `UPDATE triples SET valid_until = ?
         WHERE subject = ? AND predicate = ? AND object = ?
         AND valid_until IS NULL`
      ).run(ended, act.subject, act.predicate, act.object)
      if (info.changes === 0) {
        return { ok: false, error: '未找到匹配的有效三元组' }
      }
      return { ok: true, message: `已将 ${act.subject} → ${act.predicate} → ${act.object} 标记为失效` }
    }

    if (act.action === 'query') {
      if (!act.entity?.trim()) {
        return { ok: false, error: 'entity 不能为空' }
      }
      let rows: Triple[]
      if (act.as_of) {
        rows = db.prepare(
          `SELECT id, subject, predicate, object,
                  valid_from AS validFrom, valid_until AS validUntil,
                  created_at AS createdAt, source
           FROM triples
           WHERE (subject = ? OR object = ?)
           AND (valid_from IS NULL OR valid_from <= ?)
           AND (valid_until IS NULL OR valid_until > ?)
           ORDER BY created_at`
        ).all(act.entity, act.entity, act.as_of, act.as_of) as Triple[]
      } else {
        rows = db.prepare(
          `SELECT id, subject, predicate, object,
                  valid_from AS validFrom, valid_until AS validUntil,
                  created_at AS createdAt, source
           FROM triples
           WHERE (subject = ? OR object = ?)
           AND valid_until IS NULL
           ORDER BY created_at`
        ).all(act.entity, act.entity) as Triple[]
      }
      return { ok: true, results: rows }
    }

    if (act.action === 'timeline') {
      if (!act.entity?.trim()) {
        return { ok: false, error: 'entity 不能为空' }
      }
      const rows = db.prepare(
        `SELECT id, subject, predicate, object,
                valid_from AS validFrom, valid_until AS validUntil,
                created_at AS createdAt, source
         FROM triples
         WHERE subject = ? OR object = ?
         ORDER BY COALESCE(valid_from, created_at)`
      ).all(act.entity, act.entity) as Triple[]
      return { ok: true, results: rows }
    }

    return { ok: false, error: '未知 action' }
  } finally {
    db.close()
  }
}
