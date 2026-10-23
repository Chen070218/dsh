export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return (unit === 0 ? String(Math.round(value)) : value.toFixed(1)) + ' ' + units[unit]
}

export function truncateList(values: readonly string[], max: number): string {
  if (values.length === 0) return '（无）'
  const head = values.slice(0, max).join('、')
  return values.length > max ? head + ' 等 ' + values.length + ' 项' : head
}
