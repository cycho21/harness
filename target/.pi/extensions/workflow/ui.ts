export function banner(title: string): string {
  const width = Math.max(36, displayWidth(title) + 2);
  return [
    `╔${"═".repeat(width)}╗`,
    `║ ${padDisplay(title, width - 1)}║`,
    `╚${"═".repeat(width)}╝`,
  ].join("\n");
}

export function table(rows: string[][]): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => displayWidth(String(row[column] ?? "")))));
  return rows.map((row, index) => {
    const line = `| ${row.map((cell, column) => padDisplay(String(cell ?? ""), widths[column])).join(" | ")} |`;
    if (index !== 0) return line;
    const separator = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
    return `${line}\n${separator}`;
  }).join("\n");
}

export function padDisplay(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - displayWidth(value)));
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const char of Array.from(value)) {
    width += isWideChar(char) ? 2 : 1;
  }
  return width;
}

export function isWideChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f000 && code <= 0x1faff)
  );
}
