/**
 * Providers occasionally return an image URL as a Markdown link instead of
 * returning the URL itself:
 *
 *   [https://cdn.example/image.png](https://cdn.example/image.png)
 *
 * Keep the normalization deliberately small and format-focused. URL
 * validation remains the responsibility of the caller/backend so this helper
 * does not weaken the existing HTTPS and SSRF protections.
 */
export function normalizeImageSource(value: unknown): string {
  if (typeof value !== 'string') return '';

  let source = value.trim();
  const linkStart = source.indexOf('](');
  if (linkStart > 0 && source.endsWith(')')) {
    const labelStart = source[0] === '!' && source[1] === '[' ? 2 : source[0] === '[' ? 1 : -1;
    if (labelStart >= 0 && source.lastIndexOf('](', linkStart) === linkStart) {
      source = source.slice(linkStart + 2, -1).trim();
      if (source.startsWith('<') && source.endsWith('>')) {
        source = source.slice(1, -1).trim();
      }
    }
  }

  // A few gateways append prose punctuation after the URL. Do not strip
  // ordinary URL characters such as ')' because they may be part of a path.
  return source.replace(/[。！？，、；：]+$/u, '').trim();
}
