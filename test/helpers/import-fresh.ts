export async function importFreshModule<T>(baseUrl: string, specifier: string): Promise<T> {
  const resolved = new URL(specifier, baseUrl);
  const separator = resolved.search ? "&" : "?";
  resolved.href = `${resolved.href}${separator}fresh=${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  return (await import(resolved.href)) as T;
}
