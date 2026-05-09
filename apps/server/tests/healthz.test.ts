import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/index.js';

const app = await buildApp({ dbPath: ':memory:', agentToken: 'test:test:tok' });

afterAll(async () => {
  await app.close();
});

describe('GET /healthz', () => {
  it('returns 200 with status:ok', async () => {
    const res = await request(app.http).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('exposes a Db handle', () => {
    expect(app.db).toBeTruthy();
    const tables = app.db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all().map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['agents', 'channels']));
  });
});
