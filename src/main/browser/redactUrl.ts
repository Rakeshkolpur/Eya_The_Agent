const SECRET_PARAM = /token|key|auth|sess|sid|code|secret|sig|pass|jwt|otp|credential|bearer|ticket|nonce|csrf|xsrf/i;

/**
 * An address as the model is allowed to see it: no fragment, and no query parameter that looks like a credential
 * (or is long enough to be one) — magic-link and OAuth URLs carry live tokens. Safe to apply twice.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const kept: string[] = [];
    for (const [k, v] of u.searchParams) {
      if (SECRET_PARAM.test(k) || v.length > 40) continue;
      kept.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
    return `${u.origin}${u.pathname}${kept.length > 0 ? `?${kept.join('&')}` : ''}`.slice(0, 240);
  } catch {
    return raw.slice(0, 240);
  }
}
