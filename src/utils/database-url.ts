export function databaseUrl(value: string | undefined): string {
  if (!value) throw new Error('DATABASE_URL is required');

  const invalid = () =>
    new Error(
      'DATABASE_URL is invalid. Percent-encode reserved characters in the database password (for example @ as %40 and / as %2F), or use the encoded connection string from Supabase.',
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !/^[a-zA-Z0-9_.:[\]-]+$/.test(url.hostname) ||
    !/^\/[^/@]+$/.test(url.pathname) ||
    url.hash
  )
    throw invalid();

  return url.toString();
}
