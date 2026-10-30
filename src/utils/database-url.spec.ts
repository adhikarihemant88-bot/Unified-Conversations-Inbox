import { databaseUrl } from './database-url';

describe('Database URL configuration', () => {
  it('preserves encoded passwords and connection options', () => {
    const url =
      'postgresql://postgres:test%40value%2Fwith%23symbols@db.example.com:5432/postgres?options=-c%20search_path%3Dtest';
    expect(databaseUrl(url)).toBe(url);
    expect(databaseUrl('postgresql://inbox:inbox@localhost:5432/inbox')).toBe(
      'postgresql://inbox:inbox@localhost:5432/inbox',
    );
  });
  it('rejects malformed URLs before the worker starts without echoing credentials', () => {
    const raw =
      'postgresql://postgres:example@invalid&/password@db.example.com:5432/postgres';
    expect(() => databaseUrl(raw)).toThrow(
      'Percent-encode reserved characters',
    );
    try {
      databaseUrl(raw);
    } catch (error) {
      expect((error as Error).message).not.toContain(raw);
      expect((error as Error).message).not.toContain('example@invalid');
    }
    expect(() => databaseUrl(undefined)).toThrow('DATABASE_URL is required');
    expect(() => databaseUrl('https://db.example.com/postgres')).toThrow(
      'DATABASE_URL is invalid',
    );
  });
});
