---
name: setup-modwall
description: 给项目接入 modwall：确认 LayerMap 版本够、已接入 testpace、testpace 的 ignore 没盖住 .modwall/；把代码整理成模块、共享层和装配层（用 Postgres 的，数据库一起按模块分 schema），用 modwall init 生成配置，把 modwall check 列出的越界改到清零，整份配置让用户弹窗确认一次，整组里迁移跑完后加 modwall db check。用户要给项目接入 modwall 时使用。
---

# 接入 modwall

modwall 让 agent 默认按模块开发，越界由程序拦。它不自己解析代码：代码里的 import 和调用来自 LayerMap。它和 testpace 在同一个插件里：仓库里有 `.modwall/` 目录，`testpace full` 就会在最前面跑一次 `modwall check`，不用另外登记。

## 先确认两件事

1. **LayerMap 的版本够**：`layermap --version` 要 0.1.48 以上。没有这个命令或版本太旧，请用户装或升级 LayerMap 插件（开新会话后生效）。没有它，`modwall check` 只能查按路径判断的那部分，结果一律不通过。
2. **接入了 testpace**：仓库根目录有 `testpace.json`，`testpace verify` 能过。没有就先用 `gatelight:setup` 接入：会话说明、改文件前的检查、结束前的检查、合并前的把关都只管接入了 testpace 的仓库，没接的话只剩自己记得跑 `modwall check`。
   - 看 `testpace.json` 的 `ignore` 有没有盖住 `.modwall/`（比如写了 `.modwall/`、`.*/**`）。盖住的话，改配置不会重跑整组，放宽规则就绕过了合并门：从 `ignore` 里去掉它。

`modwall status` 会把这两件事都列出来。

## 什么时候接

- 新项目：能分出两三个独立功能时接入。太早接入只会触发"文件没有归属"。
- 开发期的项目和老项目：**直接改造**，在一个接入分支上做完，不留老代码区，不设"只拦新增"的基线，也没有"改不了就申请例外"这一步。

## 步骤（在接入分支上做）

1. **先搬目录**：把代码整理成模块（一个模块根目录下，每个功能一个子目录）、共享层（没有业务含义的东西：错误和结果、数据库连接、路由执行、身份校验这类）和装配层（程序入口、路由注册、依赖组装）。这时还没有配置，modwall 不拦。框架要求放在固定目录的文件（小程序页面、按文件路由的页面）先不动，配置里用 `map` 归到模块。只搬文件、改引用路径；要改业务逻辑时停下来告诉用户。一个仓库里有几个应用（比如前端和后端）时，每个应用各自整理成自己的模块、共享层和装配层；应用之间引用了代码的，几个应用共用的代码放进一个外面一层的共享目录。

   搬的时候一并定下这几条（共享层不放模块之间的业务契约）：
   - 拿不准归哪里的代码，先归模块，不归共享层。
   - 小程序：给别的模块用的组件挪进那个模块目录下第一层的 `components/`，modwall 把那里当作模块对外的组件。
   - 模块之间的业务类型和常量（状态、付款计划这类）归定义它的模块，从入口导出，别的模块经入口引用；不为了躲开成环挪进共享层，成环说明模块要重新划分（拿不准就问用户）。
   - 由装配层接线的接口（一个模块要用、另一个模块提供的函数），由使用它的模块声明类型、从自己的入口导出，装配层把提供方的实现接进来；不在共享层集中放这类接口。
   - 应用之间的接口契约副本（比如从后端接口生成给前端用的类型）是例外，放在各应用的共享层。

   **用 Postgres 的项目，数据库一起改造**（规则见 gatelight:modular 技能的「数据库」）：对象搬进所属模块的内部 schema（模块目录名转成小写加下划线），给别的模块用的视图、函数放进入口 schema（`<内部>_api`，不放表），没有业务含义的结构放进 `shared`，`public` 里只留扩展自带的对象；迁移放进各模块目录下的迁移子目录，文件名以 14 位时间戳开头，只留正向迁移（一个时间戳一个文件，回滚迁移不搬）；跨模块的外键改成只存 id，跨模块的读写改成走对方入口（写入走对方入口里的函数），叠在别的模块入口上的视图改成函数，迁移里不建 schema；函数都带 `SET search_path = <本模块的内部 schema>, pg_temp`，都是 `SECURITY DEFINER`（要 `COMMIT` 的过程拆开或放到应用代码里），迁移里不改 `search_path`、不切身份。库要 Postgres 16 以上。具体怎么搬（改名迁移，还是还没上线的项目把历史迁移合成每个模块一份起点）按项目定，先和用户商量。迁移由 `modwall migrate` 跑，项目不自己写迁移工具、建角色的脚本（已有的删掉，项目里写死的账号名、记录表也一起删）。
   **按模块的数据库角色和账号**：由 modwall 的两条命令建，都要 Postgres 16 以上（psql 15 以上），可以重复执行。`--psql` 给执行 SQL 的命令（SQL 从标准输入交给它，和 `modwall db check` 一样）；`--print` 只输出脚本、不连库。
   - `modwall db bootstrap --psql "<用超级用户连库的命令>"`：建库那一步。建跑迁移的账号（配置的 `database.migrator`，下面第 2 步）：能登录、不是超级用户、不继承别的角色的权限（`NOINHERIT`），能建角色、能在库里建 schema、能把 `CONNECT` 转授给它建的运行账号；收回 PUBLIC 的 `CONNECT`（角色是整个实例共用的，同一个实例上别的项目的账号连不进来）。它不设迁移账号的密码：按项目的方式设（`ALTER ROLE … PASSWORD`；开发、测试用一眼能看出是假的值，线上的放在不进仓库的文件里，不写在命令行上）。
   - `modwall migrate --psql "<用迁移账号连库的命令>"`：发现一个模块目录就建同名的角色（`NOLOGIN`，拥有对象，迁移以它执行）和它的两个 schema，`shared` 的角色和 schema 也由它建；**每个模块和共享层再建一个能登录的运行账号**（配置的 `database.login` 模板，比如 `orders_app`、`shared_app`）：只有本块内部 schema 的使用权和表、序列上的读写（以后建的表也自动授），不拥有对象、不能建对象，默认的 `search_path` 是本块的内部 schema，能连库。运行账号的密码从 psql 环境里的 `MODWALL_LOGIN_PASSWORD` 读（各运行账号同一个，每次都设；没有这个环境变量就报错、一步都不做），不写进脚本和命令行；psql 在容器里跑的（比如 `napbox exec`）不带宿主的环境变量，要在容器里的命令前面给它：`--psql "napbox exec postgres --temp $ENV -- env MODWALL_LOGIN_PASSWORD=$MODWALL_LOGIN_PASSWORD psql"`。各模块的角色和运行账号都在组角色（模板里的 `<module>` 换成 `modules`，比如 `modules_app`）里，入口 schema 的使用权、入口视图的读权限授给组角色；共享层的角色和运行账号不在组角色里。迁移账号是各模块角色的成员，不继承权限、只能切过去；运行账号不是任何模块角色的成员，切不成别的模块。每块一个 `run_migration`，迁移全文交给它执行，迁移里切身份由库拒绝；各模块和共享层的迁移按时间戳统一排序，只跑没跑过的，一个文件一个事务；记录在 `shared.modwall_migrations`（运行账号碰不到），按文件名认（文件跟着目录挪了不会再跑），跑过的迁移改了内容或删了就报错、一个都不跑。迁移里不能有 `COMMIT`、`COPY … FROM STDIN`、`CONCURRENTLY`、`VACUUM`。别人建的同名角色（同一个实例上的别的项目）它不借用，直接报错。
   - 写了迁移就跑一次 `modwall migrate`，不在起环境时自动跑。线上没有 gatelight：打包时 `modwall migrate --print > <打包目录>/migrate.sql`，发版时用迁移账号、带着 `MODWALL_LOGIN_PASSWORD` 环境变量 `psql -f` 执行它，迁移完再重启程序。
   - **程序每个模块一个连接池**，用这个模块的运行账号登录（账号名照模板拼，密码和 `MODWALL_LOGIN_PASSWORD` 同一个）；装配层把各模块自己的池注入给它，共享层要用库的也用共享层的运行账号。开发、测试也这样连，不用超级用户。不写切身份的函数，项目里已有的（事务开头切成模块的角色、中途换成别的模块、一个连接交给几个模块）删掉。
   - 几个模块要同时成功或同时失败的写入：在发起的模块自己的事务里调用对方入口里的函数（写全名，比如 `billing_api.add_invoice(…)`），它以对方的角色执行，写的是对方自己的表。
   - 要按租户、用户隔离行的（行级权限），每个事务开头用 `set_config('<项目的设置名>', …, true)` 设上下文，只用事务内的设置。
   - **连接数**：模块数 × 每个池的连接数 × 同时跑的测试进程数很容易超过本机 Postgres 默认的 100 个连接。测试里每个池开 1～2 个连接；跨模块造测试数据用迁移账号，或调对方入口里的函数，不另开别的模块的池。线上建议在程序和库之间放 PgBouncer 这类连接池中间件，跑事务模式。
2. **生成配置**：`modwall init` 按搬好的目录生成 `.modwall/config.json` 草稿，并列出还没有归属的代码文件。核对草稿：

   ```json
   {
     "roots": ["src/modules"],
     "shared": ["src/shared/**"],
     "app": ["src/main.ts", "src/app/**"],
     "entry": ["index.ts", "index.tsx", "index.js", "__init__.py"],
     "map": { "src/pages/booking/**": "booking" },
     "outside": ["*.config.ts", "scripts/**"],
     "allow": [],
     "database": { "migrations": "migrations", "shared": "src/shared/migrations", "login": "<module>_app", "migrator": "migrator" }
   }
   ```

   - `database` 只有用 Postgres 的项目写：`migrations` 是每个模块放迁移的子目录名，`shared` 是共享层的迁移目录（从仓库根目录写起），`login` 是各模块运行账号的名字模板（带一个 `<module>`，换成模块的内部 schema 名，共享层换成 `shared`，组角色换成 `modules`），`migrator` 是跑迁移用的账号。`modwall init` 不起草它，按搬好的目录手动补，名字照项目的命名起（比如 `"climbgo_<module>"`）。
   - `roots` 写目录，下面每个子目录自动是一个模块；`shared`、`app`、`outside`、`map` 的键写路径规则（`**` 跨目录，`*` 不跨目录，结尾 `/` 表示整个目录）。
   - 各项的路径不能重叠，一个代码文件只能属于其中一项。唯一的例外：直接放在模块根目录下、又要保留的文件（Python 包的 `__init__.py`、汇总各模块的 `index.ts`），在 `app` 里写到这个文件、不用通配（比如 `"app/modules/__init__.py"`），它就归装配层，不算重叠。用通配的 `app` 条目、`shared`、`outside` 都不能这样认领。`modwall init` 会把模块根目录下名字是入口文件名的文件自动写进草稿的 `app`。
   - Python 的根目录 `__init__.py` 归了装配层之后，模块不能再引用它：`from app.modules import booking`、`from .. import booking` 要改成 `from app.modules.booking import …`、`from ..booking import …`，`modwall check` 会按 R3 报出来。
   - `outside` 只放不归 modwall 管的东西（构建配置、脚本；没写 `database` 的项目的迁移）；被管的代码不能引用它们。写了 `database` 的，迁移在模块目录里，不写进 `outside`。
   - 测试文件（`tests/`、`__tests__/`、`*.test.*`、`test_*.py` 等）不归 modwall 管，不用写。
   - LayerMap 不读的目录（`node_modules`、`vendor`、`.venv`、`__pycache__`、`site-packages`、`.claude`、`.codex`、`.cursor`、`.pi`，不分大小写）里的代码，modwall 查不到它引用了谁，只有写进 `outside` 才算有归属。提交进仓库的第三方代码（比如 Go 的 `vendor/`）、agent 目录里的脚本，`modwall init` 会起草进 `outside`，向用户说明这几行。在模块、共享层、装配层里出现的不能写进 `outside`（会重叠），要换个目录名搬出来。被 git 忽略的不受影响。
   - 从这一步起，没有归属的代码文件不能新建也不能修改。

   **一个仓库里有几个应用时**按应用分开写：

   ```json
   {
     "apps": {
       "web": {
         "roots": ["apps/web/src/modules"],
         "shared": ["apps/web/src/shared/**"],
         "app": ["apps/web/src/main.tsx"],
         "entry": ["index.ts", "index.tsx"],
         "map": {}
       },
       "server": {
         "roots": ["apps/server/src/modules"],
         "shared": ["apps/server/src/shared/**"],
         "app": ["apps/server/src/main.ts"],
         "entry": ["index.ts"],
         "map": {}
       }
     },
     "shared": [],
     "outside": ["scripts/**", "infra/**"],
     "allow": []
   }
   ```

   - `apps`：每个应用一组，键是应用名。每组的 `roots`、`shared`、`app`、`entry`、`map` 和单应用时的意思一样，只管这个应用；`database` 写在用这个库的应用里（通常是后端）。注意 `apps` 是应用，`app` 是应用里的装配层。
   - 外面一层的 `shared`：几个应用共用的代码，每个应用都能引用，它不能引用任何应用的代码。没有就留空。`outside`、`allow` 只写在外面一层。所有路径都从仓库根目录写起。
   - 两种写法不能混用：写了 `apps`，外面一层就只能有 `apps`、`shared`、`outside`、`allow`。只有一个应用就用单应用的写法。
   - 应用之间不能引用代码（按 R3 拦）；模块名只要在一个应用里不重复，报告里写成 `应用名/模块名`。路径重叠照旧算配置错误：不同应用之间、应用和外面一层之间都是不同的项。
   - `modwall init` 在模块根目录分属几个应用目录时按应用分组起草，应用名取应用目录的名字（两个应用目录同名时用整个路径，`/` 换成 `-`）。应用目录只认 pnpm、npm 的工作区包（`pnpm-workspace.yaml` 的 `packages`、`package.json` 的 `workspaces`）和 `apps/`、`services/`、`packages/` 下有代码的子目录；只有一个应用目录里有模块根目录时照单应用起草。
   - **认不出来的应用目录要手动补**：不是工作区包、又不在上面几个目录下的应用（比如放在仓库根目录 `miniprogram/` 下的小程序），`modwall init` 不起草，它下面的代码在输出里列为没有归属。照着这个应用的目录在 `apps` 里手动补一组（应用名取目录名，`roots`、`shared`、`app`、`entry`、`map` 按它搬好的目录写）。草稿是单应用写法的，先把它改成按应用分组的写法（原来那一组放进 `apps`，起个应用名），再补上这一组。补完重跑 `modwall check`，直到没有归属的代码文件都归了某个应用、外面一层的 `shared` 或 `outside`。
3. **改到清零**：`modwall check` 列出全部越界，当作待办逐条按改法改（R6 是迁移文件里的数据库越界）。每个模块可以补一个 `MODULE.md`（一句职责、一句不做什么）。用 Postgres 的，在临时库上用 `modwall db bootstrap`、`modwall migrate` 跑完全部迁移后执行 `modwall db check --psql "<执行 SQL 的命令>"`（比如 `psql $DATABASE_URL`；用 napbox 的项目写 `napbox exec postgres --temp $ENV -- psql`），把它报的也改到清零：改迁移，不直接改库。这条命令用哪个账号连库都行，它只读系统目录。
4. **整份配置让用户确认一次**：首次接入时 `modwall check` 会把整份配置列为放宽项。先用白话告诉用户：分了哪几个模块（有几个应用时按应用说，还有哪些代码是几个应用共用的）、共享层和装配层是哪些、哪些路径不管，再调用 `confirm_with_user` 工具（弹窗，用户同意才算；编号和文字照 `modwall check` 输出的填）。确认后 `modwall check` 应当通过。
5. **库的检查进整组**（用 Postgres 的项目）：在项目整组（testpace 的 `full`）里，迁移跑完之后加一步 `modwall db check --psql "<执行 SQL 的命令>"`，用测试的临时库；它不通过时退出码非零，整组就不通过。顺序是：起临时库（归项目）→ `modwall db bootstrap`（超级用户）→ 设迁移账号的密码 → `modwall migrate`（迁移账号，带上 `MODWALL_LOGIN_PASSWORD`）→ `modwall db check` → 测试。写在项目的脚本里、在测试里跑都行，但要在整组里跑到、退出码不能被忽略：整组给每段命令一个环境变量 `MODWALL_DB_RECEIPTS`，`modwall db check` 查完往里交一条凭据，整组跑完时写了 `database` 的应用（有几个应用的，每个用 `--app` 各查一次）没交凭据、或没通过却接着跑完了，整组算没过。所以起库、跑迁移的脚本要把环境变量原样传给它（在容器里跑的也要带进去）。
6. **核对**：`modwall status` 应当显示 LayerMap 能用、testpace 接入了、没有越界、放宽项都同意过。
7. 提交前先问用户；合回默认分支照 testpace 的节奏（`gatelight:merge`）。

## 完成时用白话告诉用户

比如：

> 项目分成了 booking、billing、stock 三个模块，加上共享层和程序入口。以后 agent 写新功能会默认建新模块，只能通过对方的"入口"用别的模块的东西，越界会被程序拦下并告诉它怎么改。要放宽规则时会弹窗问你。合并到主分支前会自动检查一遍。

有没接上的（库的检查没进整组），也在这里说清楚。
