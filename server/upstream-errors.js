// Provider-side balance failures are distinct from the user's own balance.
// Keep this matcher broad because providers vary wording.
export function isUpstreamBalanceError(value) {
  const message = upstreamErrorText(value);
  return /余额不足|余额不够|预扣费(?:额度)?失败|预扣费|用户剩余额度|需要预扣费额度|insufficient[_ -]?(?:balance|credit|funds)|insufficient funds|credit balance|quota.*(?:不足|exceed|limit)|(?:当前余额|可用余额).*(?:需要|需支付|预扣)|需要\s*[¥￥]/i.test(message);
}

export function upstreamErrorText(value, depth = 0) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object' || depth > 4) return String(value);
  return Object.entries(value).map(([key, nested]) => `${key}: ${upstreamErrorText(nested, depth + 1)}`).join(' ').slice(0, 2000);
}
