// DKK display: dot thousands, comma decimal.
// Numbers like 12345.67 render as "12.345,67 kr"
const dkkFormatter = new Intl.NumberFormat("da-DK", {
  style: "currency",
  currency: "DKK",
  minimumFractionDigits: 2,
});

export function fmtDKK(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return dkkFormatter.format(n);
}

// Display dates as DD-MM-YYYY (no locale drift)
export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

export function fmtPct(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${n.toFixed(digits)}%`;
}
