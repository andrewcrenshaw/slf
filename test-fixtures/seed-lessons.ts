import Database from 'better-sqlite3'
import type { Grant } from '../src/types.js'

export interface LessonRow {
  id: string
  entity_type: string
  content: string
  domain: string
  gates: string
  valid_at: number | null
  invalid_at: number | null
}

export function createSeededFixture(rows: Partial<LessonRow>[]): Database.Database {
  const db = new Database(':memory:')

  db.exec(`
    CREATE TABLE lessons (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      domain TEXT NOT NULL DEFAULT 'general',
      gates TEXT NOT NULL DEFAULT '[]',
      valid_at INTEGER,
      invalid_at INTEGER
    )
  `)

  const insert = db.prepare(`
    INSERT INTO lessons (id, entity_type, content, domain, gates, valid_at, invalid_at)
    VALUES (@id, @entity_type, @content, @domain, @gates, @valid_at, @invalid_at)
  `)

  for (const row of rows) {
    insert.run({
      id: row.id ?? Math.random().toString(36).slice(2),
      entity_type: row.entity_type ?? 'fact',
      content: row.content ?? '',
      domain: row.domain ?? 'general',
      gates: JSON.stringify(row.gates ?? []),
      valid_at: row.valid_at ?? null,
      invalid_at: row.invalid_at ?? null,
    })
  }

  return db
}

export function makeFetcher(db: Database.Database) {
  return {
    async fetchFacts(_grant: Grant): Promise<Array<Record<string, unknown>>> {
      const rows = db.prepare('SELECT * FROM lessons').all() as LessonRow[]
      return rows.map(row => ({
        id: row.id,
        entity_type: row.entity_type,
        content: row.content,
        domain: row.domain,
        gates: JSON.parse(row.gates) as string[],
        valid_at: row.valid_at,
        invalid_at: row.invalid_at,
      }))
    },
  }
}
