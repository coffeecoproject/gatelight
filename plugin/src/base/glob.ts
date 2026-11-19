// 路径规则（约定里的 ignore、各模块配置里的规则）。相对仓库根目录匹配完整路径：
// `**` 跨目录，`*` 和 `?` 不跨目录，以 `/` 结尾表示整个目录。

export function globToRegExp(pattern: string): RegExp {
  let p = pattern.replace(/^\.\//, '')
  if (p.endsWith('/')) p += '**'
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

export function matcher(patterns: string[]): (path: string) => boolean {
  const res = patterns.map(globToRegExp)
  return path => res.some(re => re.test(path))
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => globToRegExp(pattern).test(path))
}
