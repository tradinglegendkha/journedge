import type { Trade } from "./types";

const MONTH_CODES: Record<string, number> = {
  F: 1, G: 2, H: 3, J: 4, K: 5, M: 6,
  N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12,
};

function parseCSVLine(line: string): string[] {
  const cols: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inQuotes = !inQuotes;
    } else if (line[i] === "," && !inQuotes) {
      cols.push(current.trim());
      current = "";
    } else {
      current += line[i];
    }
  }
  cols.push(current.trim());
  return cols;
}

function buildColMap(header: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  header.forEach((name, i) => {
    map[name.replace(/"/g, "").trim()] = i;
  });
  return map;
}

// "$211.50" -> 211.5, "$(114.00)" -> -114
function parseMoney(raw: string | undefined): number {
  if (!raw) return 0;
  const value = raw.replace(/[$,]/g, "").trim();
  if (!value) return 0;
  if (value.startsWith("(") && value.endsWith(")")) {
    return -(parseFloat(value.slice(1, -1)) || 0);
  }
  return parseFloat(value) || 0;
}

interface ParsedTimestamp {
  dateISO: string;   // YYYY-MM-DD
  time12h: string;   // H:MM AM/PM — matches the format /api/trades expects for hourOfDay extraction
  ms: number;
  year: number;
}

// Tradovate timestamps are "MM/DD/YYYY HH:MM:SS" in 24-hour time
// (confirmed against rows with hour values > 12 in real exports).
function parseTimestamp(raw: string): ParsedTimestamp | null {
  const match = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, mm, dd, yyyy, hh, min, sec] = match;

  const dateISO = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;

  const h = parseInt(hh, 10);
  const period = h >= 12 ? "PM" : "AM";
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  const time12h = `${h12}:${min} ${period}`;

  const ms = new Date(
    `${dateISO}T${hh.padStart(2, "0")}:${min}:${sec}Z`
  ).getTime();

  return { dateISO, time12h, ms, year: parseInt(yyyy, 10) };
}

// Contract year codes are a single digit (e.g. "U6" = Sep 2026). We resolve
// the digit to a full year using the trade's own year as the decade anchor,
// rather than "today's" decade — this keeps historical re-imports correct
// even if imported long after the trade happened.
function futuresYearFromDigit(digit: number, referenceYear: number): number {
  const decade = Math.floor(referenceYear / 10) * 10;
  let year = decade + digit;
  if (year < referenceYear - 5) year += 10;
  if (year > referenceYear + 5) year -= 10;
  return year;
}

interface FuturesSymbolDetails {
  root: string;
  expiry: string; // YYYY-MM — day-of-month isn't derivable from the symbol alone
}

// e.g. "MNQU6" -> { root: "MNQ", expiry: "2026-09" }
// e.g. "M2KZ5" -> { root: "M2K", expiry: "2025-12" } (root itself may contain digits)
function parseFuturesSymbol(symbol: string, referenceYear: number): FuturesSymbolDetails | null {
  const match = symbol.trim().toUpperCase().match(/^(.+?)([FGHJKMNQUVXZ])(\d{1,2})$/);
  if (!match) return null;
  const [, root, monthLetter, yearDigits] = match;
  const month = MONTH_CODES[monthLetter];
  const digit = parseInt(yearDigits, 10);
  const year = yearDigits.length === 2 ? 2000 + digit : futuresYearFromDigit(digit, referenceYear);
  return { root, expiry: `${year}-${String(month).padStart(2, "0")}` };
}

export function isTradovateCSV(csvText: string): boolean {
  const firstLine = csvText.split("\n")[0].replace(/"/g, "").trim();
  return (
    firstLine.startsWith("symbol,_priceFormat,_priceFormatType,_tickSize,buyFillId,sellFillId") &&
    firstLine.includes("boughtTimestamp") &&
    firstLine.includes("soldTimestamp")
  );
}

export function parseTradovateCSV(csvText: string): Trade[] {
  const lines = csvText.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("Empty Tradovate CSV");

  const col = buildColMap(parseCSVLine(lines[0]));
  const required = [
    "symbol", "buyFillId", "sellFillId", "qty",
    "buyPrice", "sellPrice", "pnl", "boughtTimestamp", "soldTimestamp",
  ];
  for (const name of required) {
    if (col[name] === undefined) throw new Error(`Tradovate CSV missing column: ${name}`);
  }

  const trades: Trade[] = [];

  for (const line of lines.slice(1)) {
    const c = parseCSVLine(line);

    const symbol = c[col["symbol"]];
    if (!symbol) continue;

    const bought = parseTimestamp(c[col["boughtTimestamp"]]);
    const sold = parseTimestamp(c[col["soldTimestamp"]]);
    if (!bought || !sold) {
      console.warn(`Tradovate parser: could not parse timestamps for row, skipping — "${line}"`);
      continue;
    }

    const buyPrice = parseFloat(c[col["buyPrice"]]) || 0;
    const sellPrice = parseFloat(c[col["sellPrice"]]) || 0;
    const quantity = Math.abs(parseFloat(c[col["qty"]]) || 0);
    if (quantity === 0) continue;

    // Earlier fill is the opening leg.
    const isLong = bought.ms <= sold.ms;
    const direction: "long" | "short" = isLong ? "long" : "short";
    const entryPrice = isLong ? buyPrice : sellPrice;
    const exitPrice = isLong ? sellPrice : buyPrice;
    const entryTs = isLong ? bought : sold;
    const exitTs = isLong ? sold : bought;

    const pnl = parseMoney(c[col["pnl"]]);

    const futDetails = parseFuturesSymbol(symbol, exitTs.year);
    const underlying = futDetails?.root ?? symbol;

    const buyFillId = c[col["buyFillId"]];
    const sellFillId = c[col["sellFillId"]];

    const trade: Trade = {
      id: `tradovate-${buyFillId}-${sellFillId}`,
      date: exitTs.dateISO,
      symbol,
      underlying,
      type: "future",
      direction,
      quantity,
      entryPrice,
      exitPrice,
      commission: 0,
      fees: 0,
      pnl,
      status: pnl > 0 ? "win" : pnl < 0 ? "loss" : "breakeven",
      entryTime: entryTs.time12h,
      exitTime: exitTs.time12h,
      ...(futDetails && { expiry: futDetails.expiry }),
      tags: [],
      journalEntry: "",
    };

    trades.push(trade);
  }

  return trades.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}
