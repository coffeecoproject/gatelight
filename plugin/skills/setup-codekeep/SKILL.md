---
name: setup-codekeep
description: 给项目接入 codekeep：确认已接入 testpace、testpace 的 ignore 没盖住规范配置；按项目现有的工具配好严格类型、lint（长度和复杂度上限、"这里不查"的注释要写理由）、格式检查，有前端代码的加上前端规则（页面不加说明文字、不写样式和具体的值去补），旧代码超标的记进 eslint 的批量豁免文件；写 .codekeep/config.json，把规范检查从 full 挪过来；没装 gitleaks 的问用户要不要装；跑一次 codekeep check 和整组。用户要给项目接入 codekeep、或给已接入的项目加前端规则时使用。
---

# 接入 codekeep

codekeep 管代码本身的规范：类型查得严不严、lint 和格式检查有没有、规范有没有被悄悄改松、提交里有没有密钥。它不让 AI 判断代码写得好不好，只做程序判断得了的事。它和 testpace 在同一个插件里：仓库里有 `.codekeep/` 目录，`testpace full` 就会在测试之前跑一次 `codekeep check`，不用另外登记。

`codekeep check` 依次做：

1. 配置写得对不对（`.codekeep/config.json`）。
2. 和分叉点比，规范改松了哪些：关规则、error 降成 warn、调高上限、文件不再被 lint、关掉 `noInlineConfig`、关严格类型选项、开 `skipLibCheck`、`include` 少了或 `exclude` 多了、批量豁免变多、`.gitleaksignore` 多了条目、改了 gitleaks 或 biome 的配置、改了或删了检查命令；配了前端规则的，还有主题文件、组件层目录里的样式文件改了。这些要用户在弹窗里同意；分叉点上还没有 `.codekeep/`（首次接入）的不问。
3. 依次跑 `checks` 里的命令，一条没过就停。
4. `secrets` 开着时用 gitleaks 扫分叉点之后的提交和没提交的改动。

第一期只做 TypeScript、JavaScript，lint 只比 eslint。

## 先确认

1. **接入了 testpace**：仓库根目录有 `testpace.json`，`testpace verify` 能过。没有就先用 `gatelight:setup` 接入：会话说明、整组、合并前的把关都只管接入了 testpace 的仓库。
2. **`testpace.json` 的 `ignore` 没盖住规范配置**：`.codekeep/`、eslint 的配置文件（含前端规则的那份）、`tsconfig*.json`、`eslint-suppressions.json`、`.prettierignore`、`.gitleaksignore`、`.gitleaks.toml`，配前端规则的还有主题文件和组件层的样式文件，都不能在 `ignore` 里（比如 `.*/**`、`*.json`、`*.css`）。盖住的话，改这些不会重跑整组，改松规范就绕过了合并门：从 `ignore` 里去掉它们。

## 步骤（在接入分支上做）

1. **看项目现有的工具**：类型检查（TypeScript）、lint（eslint 还是 biome）、格式（prettier 还是 biome）各有没有，各子包用的是不是同一套。缺的要新装依赖，**先问用户**，说清装什么、为什么。
   - 用 biome 的项目：eslint 那一项先不写（codekeep 不比 biome 生效的规则），biome 的配置（仓库根目录的 `biome.json`、`biome.jsonc`）改了，整组按"程序看不出改松还是改紧"问用户。
2. **配严格类型**：每个 tsconfig 开 `strict`。开了以后旧代码报错的，少的直接改；多的、或者要动业务逻辑才改得掉的，停下来问用户。
3. **配 lint**（eslint 的 flat config；批量豁免用 eslint 自带的，实测 eslint 10 有）：
   - 用工具的推荐集：`@eslint/js` 的 `recommended`，TypeScript 项目加 `typescript-eslint` 的 `recommended`（里面有不许 `any`、不许没用的变量和导入），React 项目加 `eslint-plugin-react-hooks` 的推荐集（代码里已经有 `react-hooks/...` 的注释的，不加它 lint 会报找不到规则）。
   - 长度和复杂度上限：`max-lines` 500（`{ max: 500, skipBlankLines: true, skipComments: true }`）、`max-lines-per-function` 80（同样不算空行和注释）、`complexity` 20、`max-depth` 5，都是 `error`。先放宽一点，试接后再调。
   - 只查 git 收的文件：eslint 不读 `.git/info/exclude` 和全局的排除规则，本机工具放在仓库里的目录（napbox 的 `.napbox/`、agent 开在仓库里的 `.claude/worktrees/`）只写在那里，在主目录跑会查到它们（嵌着的工作区还会按它自己的配置查、对不上主目录的批量豁免）。配置文件开头用 git 列出它不收的，放进 `ignores`：

     ```js
     import { execFileSync } from 'node:child_process'
     const gitIgnored = execFileSync('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], { cwd: import.meta.dirname, encoding: 'utf8' })
       .split('\0')
       .filter(Boolean)
       .map(path => path.replace(/[*?[\]{}()!\\]/g, '\\$&'))
     // export default [{ ignores: gitIgnored }, ...]
     ```

   - "这里不查"的注释要写理由、没用了的要删：`linterOptions: { reportUnusedDisableDirectives: 'error' }`；`@eslint-community/eslint-plugin-eslint-comments` 的 `require-description`（`eslint-disable` 一类的注释要带 `-- 理由`）；TypeScript 项目用 `@typescript-eslint/ban-ts-comment` 的默认设置（`@ts-ignore`、`@ts-nocheck` 不许用，`@ts-expect-error` 要写理由）。没装这几个插件的，装之前先问用户。
4. **格式检查**：项目有 prettier 的用它；没有的问用户要不要加。检查命令把 git 收的文件交给 prettier（`git ls-files -z --cached --others --exclude-standard | xargs -0 pnpm -s exec prettier --check --ignore-unknown --no-error-on-unmatched-pattern`），不用 `prettier --check .`：prettier 只读仓库根目录的 `.gitignore` 和 `.prettierignore`，会查到上面说的本机工具目录。新加的照项目现有的写法配（分号、引号、行宽），让改动尽量小，再 `prettier --write .` 把全部代码排一遍（改动大，先和用户说清；有别的分支正在做的，排完它们合进来会冲突，先问）。`.prettierignore` 里写上 `eslint-suppressions.json`（eslint 生成、改写它，不按 prettier 排）和锁文件。
5. **旧代码超标的记进批量豁免**：`eslint --suppress-all`，生成仓库根目录的 `eslint-suppressions.json`，提交进仓库。以后豁免只许变少：代码改好了用 `eslint --prune-suppressions` 清掉用不上的；豁免变多算改松，要用户同意。lint 不在仓库根目录跑的，用 `--suppressions-location` 指到同一个文件，并在配置里写上 `eslint.suppressions`。
6. **写 `.codekeep/config.json`**：

   ```json
   {
     "checks": [
       { "name": "类型检查", "command": "pnpm -s exec tsc -p apps/server --noEmit" },
       { "name": "lint", "command": "pnpm -s exec eslint ." },
       { "name": "格式", "command": "git ls-files -z --cached --others --exclude-standard | xargs -0 pnpm -s exec prettier --check --ignore-unknown --no-error-on-unmatched-pattern" }
     ],
     "eslint": { "config": "eslint.config.mjs" },
     "tsconfig": ["apps/server/tsconfig.json", "apps/web/tsconfig.app.json"],
     "prettier": true,
     "secrets": true
   }
   ```

   - `checks`：规范检查直接写工具命令，从仓库根目录用 sh 跑，不经过项目的脚本（脚本里删掉一行，codekeep 看不到）。每个要类型检查的 tsconfig 各写一条。
   - `eslint.config`：eslint 的配置文件，codekeep 按它对每个代码文件算"生效的规则"来比；`eslint.suppressions`：批量豁免文件，不在仓库根目录的 `eslint-suppressions.json` 时才写。不用 eslint 的项目不写 `eslint`。
   - `prettier`：用 prettier 做格式检查的写 `true`，codekeep 比每个文件查不查（往 `.prettierignore` 里加路径算改松）。
   - `tsconfig`：`checks` 里类型检查用到的 tsconfig，codekeep 比它们的严格选项。只写引用别的 tsconfig 的（`tsc -b` 用的那种总的）不用写它，写它引用的那几份。
   - `secrets`：开着时扫密钥（下一步）。
   - 路径都从仓库根目录写起。
   - 把这几条检查从项目的 `full`（`testpace.json` 的 `full`，或它调用的脚本）里挪出来，不要两边都跑。先用白话告诉用户挪了什么：`full` 直接写在 `testpace.json` 里的，改了整组会照 testpace 原有的流程弹窗；`full` 调的是脚本的，testpace 看不到脚本里删了哪行，不会弹窗，只靠这一句告诉用户。`fast` 里的 lint 和类型检查照旧留着；`fast` 没有 lint 的加上（整个仓库 lint 一遍一般几秒）。
   - 接入了 modwall 的仓库：新加的 `eslint.config.mjs` 这类配置文件没有归属，`modwall check` 会报，把它加进 `.modwall/config.json` 的 `outside`（放宽规则，整组会弹窗要用户同意一次）。
7. **密钥扫描**：`gitleaks version` 看装没装。没装的问用户要不要装（`brew install gitleaks`，别的系统见 https://github.com/gitleaks/gitleaks#installing），这是装在这台机器上的工具，用户同意了再装；用户不要的，`secrets` 写 `false`。gitleaks 用仓库根目录的 `.gitleaks.toml`、`.gitleaksignore`（有的话），旧提交里的不管，只扫这次改动。代码里的 `gitleaks:allow` 注释不认：确实不是密钥的，把那一条的 Fingerprint 加进 `.gitleaksignore`（算放松，要用户同意）。
8. **有前端代码的**，加上前端规则（下一节）。
9. **跑一次**：`codekeep check` 通过（首次接入不问用户），再跑 `testpace full`。
10. 提交前先问用户；合回默认分支照 testpace 的节奏（`gatelight:merge`）。

## 有前端代码的项目：前端规则

只管两件事：页面上不加没必要的说明文字；用了组件，不在页面里写样式、写具体的值去补。规则是"默认都不准，只放行少数几种"：只列不准用的写法列不全，agent 被拦住一种，会换成清单外最近的那种。先做 React 加 antd；别的组件库照同样的原则改组件名和参数名。微信小程序的 wxml、wxss，eslint 管不到，不配。

规则模板在这个技能目录的 [frontend.eslint.mjs](frontend.eslint.mjs)：复制到项目里（比如 `eslint.frontend.mjs`），改好开头"按项目填"的几项，在 eslint 配置里 `...frontend` 接进去。模板用到 `@eslint-community/eslint-plugin-eslint-comments`（上一节"这里不查"的注释要写理由时已经装了）。项目自己的配置里也用了 `no-restricted-syntax` 的，同一个文件只认最后一份，要把两边的条目合进一份。

1. **认出主题文件和组件层目录**，没有的建起来（新建、挪文件先和用户说清）：

   | | 接了 modwall 的项目 | 没接 modwall 的项目 |
   |---|---|---|
   | 主题文件 | `<应用>/src/shared/theme.ts` | `src/theme.ts` |
   | 组件层目录 | `<应用>/src/shared/ui/` | `src/ui/` |

   - 主题（antd 的 theme 设置）定颜色、字号、间距、圆角、组件尺寸，图标的几档尺寸、表格列宽的几档也放这里。
   - 要自己画的组件（图表、时间线这类）放组件层目录，样式写在同目录的样式文件里；组件层可以用 `className` 指向同目录的样式文件、在根上包 `ConfigProvider` 接主题，不准写行内 `style` 和具体的值。全局的基础样式也放组件层目录。
2. **填模板里"按项目填"的几项**：
   - `FRONT`、`THEME`、`UI`：前端代码、主题文件、组件层目录（从仓库根目录写起，lint 不在根目录跑的照它的位置写）。
   - `TESTS`：前端里的测试和测试用的辅助代码（默认是 `*.test.*`、`*.spec.*`、`__tests__/`），项目另有测试辅助目录的加进来。
   - `BACK`、`BACK_SKIP`：后台代码，和后台里不管的种子数据、演示数据、测试、迁移目录。没有后台代码的留空。
   - `NUMBER_OK`：能写数字的参数，只放和外观无关的。项目自己组件里和外观无关的数字参数（名字最长几个字、最早哪一年）加进来；管外观的（图标尺寸、列数、间距）不加，改成主题里的几档。
   - `ENTRY_PROPS`、`ENTRY_CHILDREN`：项目自己封装的确认框、出错条、空状态组件，正文写在哪个参数或子元素里，加进来，按正文（16 个字、一句）算。
   - `DESC_PROPS`：项目自己组件里专门放说明的参数（副标题、帮助文字这类），加进来，一律不准写。确认框、空状态的正文参数不放这里。
   - 字数上限 12、16、24 是默认值，不用改。
3. **写进 `.codekeep/config.json`**：

   ```json
   "styles": { "theme": ["apps/web/src/shared/theme.ts"], "ui": ["apps/web/src/shared/ui"] }
   ```

   `theme` 是主题文件，`ui` 是组件层目录，从仓库根目录写起，几个应用各写各的。以后主题文件、组件层目录里的样式文件（`.css`、`.less`、`.scss` 这类）新加、删掉、改了，整组都要用户在弹窗里同意，按行列出原来和现在；组件层里别的文件（组件代码、取数）改了不问。会话开始时 agent 也会听到前端的约定。
4. **旧代码**：模板给页面、业务组件、组件层、主题开了 `noInlineConfig`，这些文件里原有的"这里不查"注释（比如 `react-hooks/exhaustive-deps` 的）不再起作用，它们和旧代码里别的超标的一起记进批量豁免（`eslint --suppress-all`），只减不加。先用白话告诉用户：这些注释不起作用了，以后那几处只能改代码，或者改配置让用户同意；旧代码要不要照规则改、什么时候改，是项目自己的事。

## 完成时用白话告诉用户

比如：

> 项目的类型检查开了严格模式，lint 加上了文件和函数长度、复杂度的上限，旧代码里超标的先记下来、以后只许减少。从现在起，谁把这些规范改松（关规则、调高上限、加豁免），合并前都会弹窗问你；提交里带了密钥也会被拦下。

配了前端规则的，加一句：

> 页面上的说明文字、页面里写样式和写死的数字，lint 都会拦；颜色、尺寸只能写在主题和组件层的样式里，改它们合并前会弹窗问你。

有没接上的（没装 gitleaks、项目用 biome 所以 lint 规则没在比、小程序的页面管不到），也在这里说清楚。
