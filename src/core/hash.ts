// =============================================================================
// Content addressing for greetings. Same text ⇒ same hash, across cards and
// re-imports. Works in Bun (backend) and the browser (frontend) via Web Crypto.
// =============================================================================

/** trim, CRLF/CR → LF, Unicode NFC. Hash input only; never shown to the user. */
export function normalizeGreeting(text: string): string {
  return text.replace(/\r\n?/g, '\n').normalize('NFC').trim()
}

export async function hashGreeting(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeGreeting(text))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Guard for storage paths: hashes are 64 lowercase hex chars, nothing else. */
export function isValidHash(hash: unknown): hash is string {
  return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)
}
