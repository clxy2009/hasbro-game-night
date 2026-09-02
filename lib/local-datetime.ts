export function toLocalDateTimeValue(
  date: Date,
  offsetMinutes = date.getTimezoneOffset(),
) {
  return new Date(date.getTime() - offsetMinutes * 60_000)
    .toISOString()
    .slice(0, 16);
}
