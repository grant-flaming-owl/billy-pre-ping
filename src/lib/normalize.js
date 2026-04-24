/**
 * Strip non-numeric characters, return last 10 digits.
 * Returns null if fewer than 10 digits remain.
 */
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/**
 * Strip non-numeric characters, return first 5 digits.
 * Returns null if fewer than 5 digits remain.
 */
function normalizeZip(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 5) return null;
  return digits.slice(0, 5);
}

module.exports = { normalizePhone, normalizeZip };
