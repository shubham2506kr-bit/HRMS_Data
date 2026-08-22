export function jwtExpired(token: string): boolean {
  try {
    const payload = token.split('.')[1];
    if (!payload) return true;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.exp !== 'number' || json.exp * 1000 <= Date.now();
  } catch {
    return true;
  }
}