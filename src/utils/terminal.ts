/** Escape untrusted display text, not trusted layout or application ANSI codes.
 * Escape fields before composing messages; raw data and JSON stay unchanged.
 * Prose and composed messages may preserve LF/TAB layout and normalize CRLF.
 * Backslashes stay copyable (including Windows paths and literal escape notation).
 */
export const terminalSafe = (
  value: unknown,
  options: { preserveLayout?: boolean } = {},
): string =>
  (options.preserveLayout
    ? String(value).replace(/\r\n/g, '\n')
    : String(value)
  ).replace(
    // Keep complete emoji tag sequences; standalone and incomplete tags escape.
    // eslint-disable-next-line no-control-regex
    /\u{1f3f4}[\u{e0020}-\u{e007e}]+\u{e007f}|[\x00-\x1f\x7f-\x9f\u00ad\u061c\u180e\u200b\u200e-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\u{e0000}-\u{e007f}]/gu,
    (char) => {
      if (char.startsWith('\u{1f3f4}')) return char;
      if (options.preserveLayout && (char === '\n' || char === '\t'))
        return char;
      const code = char.codePointAt(0)!;
      return code > 0xffff
        ? `\\u{${code.toString(16)}}`
        : `\\u${code.toString(16).padStart(4, '0')}`;
    },
  );
