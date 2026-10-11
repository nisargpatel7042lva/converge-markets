/**
 * Runs once when the server starts. It asks the server's own /api/stats for a reading a few seconds after boot, which
 * warms that route's cache (about ten seconds of chain reads on a cold cache), so the first visitor to the stats page
 * gets an answer at once instead of a spinner. It goes through HTTP because Next bundles the route separately and a
 * direct import would warm a different copy of the cache.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const port = process.env.PORT ?? "3000";
  setTimeout(() => {
    fetch(`http://127.0.0.1:${port}/api/stats`).catch(() => undefined);
  }, 4000).unref();
}
