export async function readJsonSafe(res: Response) {
  const text = await res.text();

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {
      error: text.trim().startsWith('<')
        ? `Server returned HTML instead of JSON (status ${res.status})`
        : text || `Request failed with status ${res.status}`,
    };
  }
}
