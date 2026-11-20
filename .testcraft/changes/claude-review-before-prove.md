# claude/review-before-prove

调"证明能抓错"和放水检查的时机：复查前跑一次（检查员要看输出），复查的两轮之间不重跑、停止门也不催，问题都改完后再跑一次。加 `testcraft review start`、`testcraft review done` 记"复查中"。原因见测试写法方案 5.7。

## 证明方式

- 复查开始前这份改动要先证明过，没证明的不让开始 —— 新测试 `plugin/tests/craft/review.test.ts` 的"复查开始前这份改动要先证明过：没证明的不让开始，证明了才让"
- 复查中改了测试，停止门不催证明，只提醒一次；结束后还缺的照常催 —— 新测试 `plugin/tests/craft/review.test.ts` 的"复查中改了测试，停止门不催证明，只提醒一次复查还开着；复查结束后照常催"
- 复查中没改测试，结束时不要求重跑 —— 新测试 `plugin/tests/craft/review.test.ts` 的"复查中没改测试，结束时不要求重跑"
- 没结束的复查只管当时那次改动，换了任务不算 —— 新测试 `plugin/tests/craft/review.test.ts` 的"没结束的复查只管当时那次改动：合并后在同一个目录里做下一件事，停止门照常催"
- 复查只管开它的那个工作目录，同一个仓库的另一个工作目录照常催 —— 新测试 `plugin/tests/craft/review.test.ts` 的"复查只管开它的那个工作目录：同一个仓库的另一个工作目录改了测试，停止门照常催"（检查员第一轮指出没测到后补的）
- 复查中清单照常拦，和复查的提醒一起说 —— 新测试 `plugin/tests/craft/review.test.ts` 的"复查中清单照常拦：改到了清单条目的触发条件、没写怎么查的，和复查的提醒一起说"（同上）
- `testcraft review` 后面只认 start 和 done —— 新测试 `plugin/tests/craft/review.test.ts` 的"review 后面只认 start 和 done"
- 没开复查时停止门和原来一样（没证明拦一次、证明过放行、要写理由的要求放水检查、只管这个会话改的、清单） —— 已有检查（`plugin/tests/craft/hooks.test.ts` 本来就守着，没改）
- "还缺哪几项"的算法从停止门挪到 `plugin/src/craft/review.ts`（停止门和 `review start`、`review done` 共用），算法没变 —— 已有检查（同上）
- 会话开始的约定、两个技能说明、`testcraft status` 多出的一行"复查：开着" —— 看代码：只是文字
