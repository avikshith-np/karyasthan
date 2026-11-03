// A caller's number in E.164. Pure.
//
// A number with no country code on it (10 digits, or 11 with a leading 0) takes the install's
// CALL_DEFAULT_COUNTRY_CODE. With none set it isn't guessed: null, an unknown caller.

export function toE164(raw, defaultCountryCode = '') {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  d = d.replace(/\D/g, '');
  const code = /^\d{1,4}$/.test(defaultCountryCode) ? defaultCountryCode : '';
  if (d.length === 10) return code ? `+${code}${d}` : null;
  if (d.length === 11 && d.startsWith('0')) return code ? `+${code}${d.slice(1)}` : null;
  return d ? `+${d}` : null;
}
