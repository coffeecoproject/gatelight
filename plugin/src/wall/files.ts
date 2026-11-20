// 文件的认法，和 LayerMap 一致：哪些是代码文件（它支持的四种语言）、哪些是测试文件、哪些目录它不读。
// 测试文件不归 modwall 管；LayerMap 给的 import 里也没有来源是测试文件的。
// LayerMap 不读的目录里的代码，modwall 照样列进文件清单：它引用了谁查不到，只有写进 outside 才算有归属（layout.ts）。

/** LayerMap 认作测试的路径（它的 mapTestPath）。 */
const TEST_PATH =
  /(?:^|\/)(?:__tests__|tests?|fixtures?|testFixtures|e2e|testdata)(?:\/|$)|\.(?:spec|test)\.|_test\.(?:go|py)$|(?:^|\/)(?:test_[^/]*\.py|conftest\.py)$/iu

/** LayerMap 四种语言的源文件：TS/JS、Python、Go、Java。 */
const CODE = /\.(?:[cm]?[jt]sx?|pyi?|go|java)$/u

/** R1（必须走入口）第一版只管的语言：TS/JS 和 Python。 */
const ENTRY_LANGUAGE = /\.(?:[cm]?[jt]sx?|pyi?)$/u

/** LayerMap 不读的目录名（它的 excludedSegments）：依赖、缓存、coding agent 自己的目录。 */
export const UNREAD_DIRECTORIES = ['node_modules', 'vendor', '.venv', '__pycache__', 'site-packages', '.claude', '.codex', '.cursor', '.pi']
const UNREAD = new Set(UNREAD_DIRECTORIES)

/** 样式文件：不能经模块入口导出（R1 的改法不同）。 */
const STYLESHEET = /\.(?:css|scss|sass|less|styl|stylus|pcss|wxss|acss)$/iu

export const isTest = (path: string): boolean => TEST_PATH.test(path)
export const isStylesheet = (path: string): boolean => STYLESHEET.test(path)
export const isCode = (path: string): boolean => CODE.test(path)
export const inEntryLanguage = (path: string): boolean => ENTRY_LANGUAGE.test(path)

/**
 * 这个文件在 LayerMap 不读的目录里时，给出那个目录（从仓库根目录写到最外层那一段，大小写照原样）。
 * 认法和 LayerMap 的 inExcludedDirectory 一样：转小写、按 / 切开、去掉最后的文件名，看有没有哪一段在清单里。
 */
export function unreadDirectory(path: string): string | undefined {
  const segments = path.split('/').slice(0, -1)
  const index = segments.findIndex(segment => UNREAD.has(segment.toLowerCase()))
  return index === -1 ? undefined : segments.slice(0, index + 1).join('/')
}
