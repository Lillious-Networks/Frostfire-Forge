// Builds the SQL text the database worker sends. Kept apart from the worker so it can be tested without a connection.

/**
 * The statements are written for MySQL. Two of its forms SQLite does not read, and both are how a
 * system says "insert this row, unless one is in the way":
 *
 *   INSERT IGNORE INTO ...               SQLite: INSERT OR IGNORE INTO ...
 *   ... ON DUPLICATE KEY UPDATE a = ?    SQLite: ... ON CONFLICT DO UPDATE SET a = ?
 *
 * and in that update, VALUES(a) (the value the insert carried) is excluded.a. The upsert names no
 * key, as MySQL's does not: it is whichever unique key the row broke.
 *
 * Only the statement's own words are rewritten, before any value is put in: a value, or a quoted
 * part of the statement, that holds the same words is text and is left as it is.
 */
function forSqlite(query: string): string {
  if (!/\b(IGNORE|DUPLICATE)\b/i.test(query)) return query;

  const carried = (text: string) => text.replace(/\bVALUES\s*\(\s*([A-Za-z_]\w*)\s*\)/gi, "excluded.$1");
  // Every other piece is a quoted literal, with a doubled quote read as part of it.
  const pieces = query.split(/('(?:[^']|'')*')/);
  let updating = false;
  for (let i = 0; i < pieces.length; i += 2) {
    let piece = pieces[i];
    if (i === 0) piece = piece.replace(/^(\s*)INSERT\s+IGNORE\s+INTO\b/i, "$1INSERT OR IGNORE INTO");
    if (updating) {
      piece = carried(piece);
    } else {
      const at = piece.search(/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i);
      if (at !== -1) {
        updating = true;
        piece = piece.slice(0, at) + carried(piece.slice(at).replace(/^ON\s+DUPLICATE\s+KEY\s+UPDATE\b/i, "ON CONFLICT DO UPDATE SET"));
      }
    }
    pieces[i] = piece;
  }
  return pieces.join("");
}

export function sqlWrapper(query: string, params: any[], engine: DatabaseEngine): string {
  if (engine === "sqlite") query = forSqlite(query);
  const parts = query.split("?");
  if (parts.length - 1 !== params.length) {
    throw new Error("Number of placeholders does not match number of parameters");
  }

  let result = parts[0];
  for (let i = 0; i < params.length; i++) {
    const param = params[i];

    if (Array.isArray(param)) {
      if (param.length === 0) {
        throw new Error("Cannot use empty array as SQL parameter");
      }
      const escapedArray = param.map(p => escapeValue(p, engine)).join(", ");
      result += escapedArray + parts[i + 1];
    } else {
      result += escapeValue(param, engine) + parts[i + 1];
    }
  }

  return result;
}

export function escapeValue(param: any, engine: DatabaseEngine): string {
  if (param === null || param === undefined) {
    return "NULL";
  } else if (typeof param === "string") {
    return escapeString(param, engine);
  } else if (typeof param === "number") {
    return param.toString();
  } else if (typeof param === "boolean") {
    return param ? "1" : "0";
  } else if (param instanceof Date) {
    return "'" + param.toISOString().slice(0, 19).replace("T", " ") + "'";
  } else {
    return escapeString(String(param), engine);
  }
}

/**
 * MySQL reads a backslash inside a string literal as an escape character, so an unescaped one
 * changes the next character and, at the end of a value, escapes the closing quote. SQLite and
 * Postgres (with its default standard_conforming_strings) read a backslash as itself: doubling it
 * there would store two.
 *
 * On MySQL only the backslash and NUL are escaped. The quote stays doubled rather than written as
 * \', and line breaks and the like stay raw, so the literal still ends where it should on a server
 * running with NO_BACKSLASH_ESCAPES (which would store the doubled backslash as two).
 */
function escapeString(value: string, engine: DatabaseEngine): string {
  if (engine === "mysql") {
    value = value.replaceAll("\\", "\\\\").replaceAll("\0", "\\0");
  }

  return "'" + value.replace(/'/g, "''") + "'";
}
