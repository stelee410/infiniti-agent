import Database from 'better-sqlite3'
import { mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { localAgentDir } from '../paths.js'

const VECTOR_DB_FILE = 'vectors.db'
const VECTOR_DIM = 384

function vectorDbPath(cwd: string): string {
  return join(localAgentDir(cwd), VECTOR_DB_FILE)
}

let vecExtensionLoaded = false

function openVectorDb(cwd: string): Database.Database {
  const p = vectorDbPath(cwd)
  const db = new Database(p)
  db.pragma('journal_mode = WAL')

  if (!vecExtensionLoaded) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = require('sqlite-vec')
      sqliteVec.load(db)
      vecExtensionLoaded = true
    } catch {
      db.close()
      throw new Error(
        'sqlite-vec 加载失败。向量搜索不可用。请确认 sqlite-vec 已安装：npm install sqlite-vec'
      )
    }
  }

  ensureVectorSchema(db)
  return db
}

function ensureVectorSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vector_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_id TEXT,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS vector_idx USING vec0(
      embedding float[${VECTOR_DIM}]
    );
  `)
}

export type VectorDoc = {
  id: number
  source: string
  sourceId: string | null
  content: string
  metadata: string | null
  distance: number
}

export async function addVectorDoc(
  cwd: string,
  source: string,
  content: string,
  embedding: Float32Array,
  sourceId?: string,
  metadata?: Record<string, unknown>,
): Promise<number> {
  await mkdir(dirname(vectorDbPath(cwd)), { recursive: true })
  const db = openVectorDb(cwd)
  try {
    const docId = db.transaction(() => {
      const info = db.prepare(
        'INSERT INTO vector_docs (source, source_id, content, metadata) VALUES (?, ?, ?, ?)'
      ).run(source, sourceId ?? null, content, metadata ? JSON.stringify(metadata) : null)
      const id = info.lastInsertRowid as number

      db.prepare(
        'INSERT INTO vector_idx (rowid, embedding) VALUES (?, ?)'
      ).run(id, Buffer.from(embedding.buffer))

      return id
    })()
    return docId
  } finally {
    db.close()
  }
}

export async function searchVectors(
  cwd: string,
  queryEmbedding: Float32Array,
  limit: number = 10,
  sourceFilter?: string,
): Promise<VectorDoc[]> {
  await mkdir(dirname(vectorDbPath(cwd)), { recursive: true })
  const db = openVectorDb(cwd)
  try {
    const queryBuf = Buffer.from(queryEmbedding.buffer)

    let sql: string
    const params: unknown[] = [queryBuf, limit]

    if (sourceFilter) {
      sql = `
        SELECT d.id, d.source, d.source_id AS sourceId, d.content, d.metadata, v.distance
        FROM vector_idx v
        JOIN vector_docs d ON d.id = v.rowid
        WHERE v.embedding MATCH ?
        AND d.source = ?
        ORDER BY v.distance
        LIMIT ?
      `
      params.splice(1, 0, sourceFilter)
    } else {
      sql = `
        SELECT d.id, d.source, d.source_id AS sourceId, d.content, d.metadata, v.distance
        FROM vector_idx v
        JOIN vector_docs d ON d.id = v.rowid
        WHERE v.embedding MATCH ?
        ORDER BY v.distance
        LIMIT ?
      `
    }

    return db.prepare(sql).all(...params) as VectorDoc[]
  } finally {
    db.close()
  }
}

export async function isVectorStoreAvailable(cwd: string): Promise<boolean> {
  try {
    await mkdir(dirname(vectorDbPath(cwd)), { recursive: true })
    const db = openVectorDb(cwd)
    db.close()
    return true
  } catch {
    return false
  }
}
