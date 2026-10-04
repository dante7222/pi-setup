// Process-wide fixture: use only in sequential tests (Node isolates test files).
// Scrub the whole control namespace, including future markers, not just WORKER.
export function isolateHerdrEnvironment(t, overrides, cleanup = async () => {}) {
  const controlled = (key) => key.startsWith("PI_HERDR_") || key.startsWith("HERDR_") || Object.hasOwn(overrides, key);
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => controlled(key)));
  const restore = () => {
    for (const key of Object.keys(process.env)) if (controlled(key)) delete process.env[key];
    Object.assign(process.env, previous);
  };
  // Register before mutation or any fallible/async fixture setup. Restoration
  // must be in finally: Node may skip later hooks after a cleanup hook fails.
  t.after(async () => {
    try { await cleanup(); } finally { restore(); }
  });
  try {
    for (const key of Object.keys(process.env)) if (controlled(key)) delete process.env[key];
    Object.assign(process.env, overrides);
    return { ...process.env };
  } catch (error) {
    restore();
    throw error;
  }
}
