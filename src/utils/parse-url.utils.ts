/**
 * The one place the native URL API's `null` is translated to `undefined`.
 *
 * `URL.parse` is the borrowed API and it speaks null; everything above this line speaks undefined.
 * Wrapping it once means a single file owns that edge, and it gives us somewhere to put a fix if
 * the native behaviour ever needs one.
 */
export const parseUrl = (rawUrl: string): URL | undefined => URL.parse(rawUrl) ?? undefined;
