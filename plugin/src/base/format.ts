// 时间和时长的显示。

export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分${String(seconds % 60).padStart(2, '0')}秒`
  return `${Math.floor(minutes / 60)}小时${String(minutes % 60).padStart(2, '0')}分`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function when(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function day(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function short(tree: string): string {
  return tree.slice(0, 10)
}
