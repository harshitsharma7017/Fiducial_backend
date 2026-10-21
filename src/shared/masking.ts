// Masking of sensitive values (N12) for users without the permission to see them in full. The
// API masks before a response or file leaves the server; the web app never receives the value.

/** A bank account: all but the last 4 digits as X (123456789012 → XXXXXXXX9012). */
export function maskAccount(value: string | null | undefined): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, '');
  if (compact.length <= 4) return 'X'.repeat(compact.length);
  const shown = compact.length >= 8 ? 4 : 2;
  return `${'X'.repeat(compact.length - shown)}${compact.slice(-shown)}`;
}

/** A phone number: only its last 4 digits. */
export function maskPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return 'X'.repeat(digits.length);
  return `${'X'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}
