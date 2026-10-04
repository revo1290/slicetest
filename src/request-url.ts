// Not `new URL(target, base)`: for `//users/42` that reads `users` as a host, and the path is lost.
export function requestUrl(target: string | undefined, base: string | URL): URL {
  const raw = target ?? "/";
  return raw.startsWith("/") ? new URL(new URL(base).origin + raw) : new URL(raw, base);
}
