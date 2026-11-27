// 检查模块交给底座的入口。底座（这个目录）不认识任何模块：合并门、停止门、会话说明、整组都按这里的入口去问，
// 模块（比如 ../pace 跑测试）把自己的实现登记进来。登记由装配的文件做（src/modules.ts），底座的代码不引用模块。

import type { Repo } from './repo.ts'
import type { RunRecord } from './store.ts'

/** 整组里的一段：一条要跑的命令。kind 记进运行记录的分段用时（RunStep.kind），由模块自己定名字。 */
export interface FullStep {
  kind: string
  /** 耗时报告里这一段的名字：固定的，不带数量（比如"全部测试"）。记进运行记录的分段用时（RunStep.name）。 */
  name: string
  /** 没通过时说的名字，比如"全部测试（12 个文件）"。 */
  title: string
  /** 写进日志的分隔行。 */
  header: string
  command: string
  args: string[]
  /** 这一段要借用工作区（比如建副本）：底座把这一轮的运行 id 给它（见 execute.ts 的 RUN_ENV），它借用时不另占。只给测试之前跑的检查。 */
  borrows?: boolean
}

/** 一个模块在这一轮整组里的部分。 */
export interface FullPart {
  steps: FullStep[]
  /** 整组通过时说的一小段，比如"12 个测试文件"。 */
  summary?: string
  /** 给这个模块各段命令的环境变量（比如交每个测试结果的位置）。 */
  env?: Record<string, string>
  /**
   * 各段跑完（没被中断）以后：模块往这次的运行记录里加自己的字段（fields），在记录写下之后说给 agent 的话（notes，
   * 拿得到写好的记录和这之前的全部记录）。
   * failedStep 是没过的那一段的 name（各段都过了时没有）：模块自己的段跑了、没过的，照样可以核对它跑到了什么，写进 notes。
   * problems：按跑完交回来的东西核对出的问题（比如该跑到的没跑到），一条一句、写明怎么改。各段都过了、却有问题的，整组算没过；
   * 有哪一段没过时不看（已经算没过了）。
   */
  finish?(failedStep?: string): { fields?: Record<string, unknown>; problems?: string[]; notes?(record: RunRecord, before: RunRecord[]): string[] }
  /** 这一轮结束（不管怎么结束）时收拾模块自己的临时文件。 */
  dispose?(): void
}

export interface Module {
  name: string

  /** testpace.json 里归这个模块的字段名：别的字段底座报"未知字段"。 */
  fields?: readonly string[]
  /** 这个模块的字段写得对不对（raw 是 testpace.json 的内容）。问题说给 agent，整组跑不了。 */
  contractProblems?(raw: Record<string, unknown>): string[]

  /**
   * 会话说明：在这个仓库里干活要知道的规矩。会话开始、压缩后、会话第一次碰到这个仓库时说。label 是话里指这个仓库的写法；
   * 给了 repo 就是在说那个仓库，模块没在那个仓库里启用的不用说。
   */
  brief?(label: string, repo?: Repo): string[]
  /**
   * 会话碰到这个工作区时（会话开始、每条命令之前、每次改文件之前都来）：模块记下会话在这里的起点（比如这时测试的样子，
   * 停止门只管这之后改的）。用底座的 SessionBaselines 记（baseline.ts）：只记第一次，已经有了就不再算。
   */
  onSession?(repo: Repo, sessionId: string): void
  /** 会话说明里跟在后面的提醒：这个仓库现在有什么要留意的（比如时好时坏的测试）。 */
  alerts?(repo: Repo): string[]

  /** 工具调用前：agent 要在 cwd 里跑这条命令时给它的提示。 */
  beforeCommand?(command: string, cwd: string): string | undefined
  /**
   * 改文件之前：agent 要用改文件的工具新建或修改这个仓库里的 path（相对仓库根目录）。返回原因就拒绝这次改动，
   * 话里要说清怎么改。每次改文件都会问，只做看路径、看要写的文字就能判断的事。text 是这次要写进文件的新文字
   *（整份内容，或替换进去的那几段），拿不到时没有。
   */
  beforeEdit?(repo: Repo, path: string, text?: string): string | undefined

  /**
   * 停止门：这个会话在这个仓库里还有没处理完的事。keys 是这几件事各自的记号，底座记下拦过的，每件只拦一次
   * （seen 是已经拦过的）；named 为真时话里要写明是哪个仓库（会话不是在这个仓库里开始的）。
   * notice 是同时直接给用户看的一行（agent 转述可能被一句带过的事），不给就只说给 agent。
   */
  unfinished?(repo: Repo, sessionId: string, seen: readonly string[], named: boolean): { keys: string[]; text: string; notice?: string } | undefined

  /** 整组里这个模块的部分；现在跑不了（配置不对、没有要跑的）时给出原因。 */
  fullPart?(repo: Repo): FullPart | { problem: string }
}

let registered: Module[] = []

/** 登记这次运行里的模块（装配的文件调用，整份换掉）。 */
export function registerModules(modules: Module[]): void {
  registered = modules
}

export function modules(): readonly Module[] {
  return registered
}
