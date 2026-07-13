export const TEST_FILE_RE =
  /(\.(test|spec|stories|story)\.[jt]sx?$)|([\\/](__tests__|__mocks__|__stories__|tests?|fixtures|testing)[\\/])/;

export const WRAPPER_NAMES = new Set(['memo', 'forwardRef', 'observer']);

/**
 * Key a passed literal by type as well as value, so boolean `true`, string
 * `"true"`, and number `1` vs string `"1"` never collide when matched
 * against union variants.
 */
export function literalKey(value: string | number | boolean): string {
  return `${typeof value}:${String(value)}`;
}
