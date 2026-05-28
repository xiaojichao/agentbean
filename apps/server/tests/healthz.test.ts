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

  it('allows browser REST preflight from the web app origin', async () => {
    const res = await request(app.http)
      .options('/api/networks/default/agents/a1/workspace')
      .set('Origin', 'http://localhost:3100')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3100');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
  });

  it('derives browser REST CORS from WEB_URL when CORS_ORIGIN is not set', async () => {
    const previousCorsOrigin = process.env.CORS_ORIGIN;
    const previousWebUrl = process.env.WEB_URL;
    delete process.env.CORS_ORIGIN;
    process.env.WEB_URL = 'https://agentbean.example.com';

    const corsApp = await buildApp({ dbPath: ':memory:', globalDbPath: ':memory:', agentToken: 'test:test:tok' });
    try {
      const res = await request(corsApp.http)
        .options('/api/networks/default/artifacts/upload')
        .set('Origin', 'https://agentbean.example.com')
        .set('Access-Control-Request-Method', 'POST');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('https://agentbean.example.com');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
    } finally {
      await corsApp.close();
      if (previousCorsOrigin === undefined) delete process.env.CORS_ORIGIN;
      else process.env.CORS_ORIGIN = previousCorsOrigin;
      if (previousWebUrl === undefined) delete process.env.WEB_URL;
      else process.env.WEB_URL = previousWebUrl;
    }
  });

  it('exposes a Db handle', () => {
    expect(app.db).toBeTruthy();
    const tables = app.db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all().map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['agents', 'channels']));
  });
});
