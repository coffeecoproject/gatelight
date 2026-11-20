# claude/wall-join

modwall 搬进来成"模块边界"模块（`plugin/src/wall/`），改用底座；去掉在本机登记附加检查这条路。设计见 `整体设计方案.md` 的 9.5。

## 证明方式

- "模块边界"原有的规则（R1–R6、配置校验、放宽项怎么认、数据库检查、小程序引用、起草配置）—— 新测试：从 modwall 仓库搬来的 `plugin/tests/wall/` 下 9 个文件（apps、check、config、database、dbcheck、init、loosen、miniprogram、rules）。规则本身的断言没动；跟着底座变了的有这几处：引用路径；apps 里测钩子的那个仓库多写一份 `testpace.json`（钩子只管接入了 testpace 的仓库），确认的输出按底座的格式认；check 里日志的位置（`.git/testpace/logs/*-modwall-check.log`）、"layermap 版本太旧"两处、"认不出默认分支"一处的文字；database 里 `modwall status` 三种状态的文字和先后。另给 apps 补了一条原来就没测的（应用的值不是对象时报错）
- 钩子只管接入了 testpace 的仓库（只接了 modwall、没接 testpace 的仓库，会话说明、改文件前的检查、停止门都不再管）—— 这是放松，整体设计方案第 10 节已定："modwall 不装 testpace 也能用：放弃"。新测试 `plugin/tests/wall/hooks.test.ts` 的"没接入、配置有错、不在仓库里：不拦"和 `plugin/tests/wall/module.test.ts` 的"没接入 testpace：说明钩子和合并门都不管它"
- 放宽项的同意按"哪一项改动加看到的文字"记，不只按文字记 —— 新测试 `plugin/tests/wall/confirm.test.ts` 的"文字一样、删掉的是另一份配置：是另一项，要重新同意""两个分支在同一份配置上做同一项放宽：是同一个决定，共用一次同意"
- 通过记录按开始检查时的内容记，检查过程中内容改过不记 —— 新测试 `plugin/tests/wall/module.test.ts` 的"检查的过程中内容改过：这次不记、不算通过"
- 接入了的仓库整组最前面有 modwall check 这一段，删掉 `.modwall/` 躲不过 —— 新测试 `plugin/tests/wall/module.test.ts` 的"整组里的模块边界"三条
- 改文件之前拦没有归属的代码文件、会话说明、停止门同一份内容只拦一次 —— 新测试 `plugin/tests/wall/hooks.test.ts`
- 整组按模块的顺序跑各段、一段没过就停、要借用工作区的段才拿得到运行 id —— 新测试 `plugin/tests/cli.test.ts` 的"整组里各模块交的各段"
- 耗时报告按模块给的名字列各段 —— 已有检查改了期望值：`plugin/tests/units.test.ts` 的"整组的时间花在哪一段"
- 这几处另外各故意改坏一次，对应的测试都没通过（放宽项只按文字记、通过记录不核对内容、整组只看工作区有没有 `.modwall/`、停止门反复拦、没接入 testpace 的仓库也拦、模块顺序、报告不用模块给的名字、不借用的段也给运行 id）

## 放水理由

- `plugin/tests/cli.test.ts`：去掉了"在本机登记附加检查"（全局 git 配置 `testpace.check`）这个功能，检查改成随插件一起装的模块。原来"附加检查"一组 6 个测试是靠登记命令来测整组怎么跑各段的：其中 5 个换成用测试里加的段来测同样的事（顺序和分段用时、一段没过就停、前一段没过后一段不跑、借用工作区的运行 id、失败节选是失败那一段的），断言里"附加检查"的字样换成"加的段"，`record.checks`、"附加检查通过："那一行、status 里那一行随功能一起没有了；"登记的命令找不到：说明怎么取消登记"删掉，因为没有登记了。另加一个测试守"留着的 testpace.check 不再跑"
- `plugin/tests/units.test.ts`：整组各段的名字改成由模块给（`RunStep.name`），报告不再认 `kind: 'check'` 和登记的命令。期望里"附加检查 testcraft check"换成"测试写法的检查（testcraft check）"，并多测一条旧记录没有名字时"跑测试"自己的两段照样认得
- `plugin/tests/hooks.test.ts`：钩子配置里工具调用前那一项多认了改文件的三个工具（Edit、Write、MultiEdit），用来在改文件之前问"模块边界"拦不拦。期望的 matcher 从 `Bash` 改成 `Bash|Edit|Write|MultiEdit`，测试名跟着改
- `plugin/tests/craft/prove.test.ts`：这个测试要一轮停在测试之前的整组。原来靠登记一条附加检查来停住，现在改成用测试里加的一段（要借用工作区的）来停住，查的东西没变：整组在跑时不建副本；带着这一轮的运行 id 照常建；整组照常跑完
- `plugin/tests/helpers.ts`：加了 `fullWithSteps`（在整组最前面加几段再跑），给上面两个文件用；原有的没动
- `eslint.config.mjs`：只加不减。模块之间不许互相引用的那几条规则里加上了新模块 `wall`（底座不许引用它，它和"跑测试""测试写法"互相不许引用）；"测试里要有断言"那条规则多管 `plugin/tests/wall/` 下的测试。原有的规则没有放宽

## 给用户过目

- `plugin/tests/cli.test.ts`：原来查的是"在这台电脑上另外登记的检查，整组会先跑它，没过就不往下跑、不算通过"；现在这种另外登记的办法去掉了，检查改成随插件一起装，所以改成查"随插件装的各项检查，整组按顺序跑，没过就不往下跑、不算通过"，原来查的几件事都还在查。只有一条不查了："登记的命令找不到时提示怎么取消登记"，因为已经没有登记这回事。这是整体设计方案第 4.4 节定的："不再靠全局 git 配置登记，模块随底座一起装"
- `plugin/tests/units.test.ts`：原来查耗时报告里有一行"附加检查 某条命令"；现在查的是每项检查用自己的名字各占一行（比如"测试写法的检查"），原因同上
- `plugin/tests/hooks.test.ts`：原来查的是"插件只在 agent 执行命令时插手"；现在查的是"agent 执行命令和改文件之前都插手"。多出来的改文件这一处，是给"模块边界"用的：新建的代码文件不属于任何模块时当场拦下。原来查的执行命令那部分照旧在查
- `plugin/tests/craft/prove.test.ts`：查的事情没变（整组正在跑的时候，"证明测试能抓错"不会另外占用工作区；整组自己的那一段照常能用）。只是让整组停在半路的办法换了：原来靠另外登记一条检查，现在这种登记去掉了，改成测试里临时加一段检查
