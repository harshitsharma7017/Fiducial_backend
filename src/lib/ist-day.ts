/** The date in India (YYYY-MM-DD) at an instant. */
export function istDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(at);
}
