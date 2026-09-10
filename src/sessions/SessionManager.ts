import * as fs from 'fs';
import * as path from 'path';
import { AutonomyLevel, Session } from '../types';

function newId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `session-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${d
    .getTime()
    .toString(36)}`;
}

export class SessionManager {
  readonly dir: string;

  constructor(projectRoot: string) {
    this.dir = path.join(projectRoot, '.luicode', 'sessions');
  }

  ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  list(): Array<{ file: string; id: string; updatedAt: number; task: string; status: string }> {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as Session;
          return { file: f, id: s.id, updatedAt: s.updatedAt, task: s.task, status: s.status };
        } catch {
          return { file: f, id: f, updatedAt: 0, task: '(corrupt)', status: 'error' };
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  latest(): Session | null {
    const list = this.list();
    if (!list.length) return null;
    return this.load(list[0].file);
  }

  create(task: string, mode: AutonomyLevel): Session {
    this.ensureDir();
    const now = Date.now();
    const session: Session = {
      id: newId(),
      createdAt: now,
      updatedAt: now,
      task,
      mode,
      messages: [{ role: 'user', content: task, timestamp: now }],
      actions: [],
      fileChanges: [],
      commands: [],
      testResults: [],
      errors: [],
      status: 'active'
    };
    return session;
  }

  save(session: Session): void {
    this.ensureDir();
    session.updatedAt = Date.now();
    fs.writeFileSync(path.join(this.dir, `${session.id}.json`), JSON.stringify(session, null, 2), 'utf8');
  }

  load(fileOrId: string): Session | null {
    const candidates = [
      path.join(this.dir, fileOrId.endsWith('.json') ? fileOrId : `${fileOrId}.json`),
      fs.existsSync(path.join(this.dir, fileOrId)) ? path.join(this.dir, fileOrId) : ''
    ].filter(Boolean);
    if (!candidates.length) return null;
    try {
      return JSON.parse(fs.readFileSync(candidates[0], 'utf8')) as Session;
    } catch {
      return null;
    }
  }
}