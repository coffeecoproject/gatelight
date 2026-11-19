import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { forUserLine, readRecords, reasonFor } from '../../src/craft/records.ts'
import { tempDir, write } from './helpers.ts'

const RECORD = '.testcraft/changes/feature.md'

const read = (text: string): ReturnType<typeof readRecords> => {
  const root = tempDir('testcraft-records-')
  write(root, RECORD, text)
  return readRecords(root, [{ status: 'A', path: RECORD }])
}

describe('读改动记录', () => {
  test('放水理由只认行首的文件；正文里的反引号原样留着，不算文件', () => {
    const records = read('# feature\n\n## 放水理由\n\n- `.testcraft/config.json`：`notTests` 写 `tests/**`，那里不算测试；和 `tests/price.test.ts` 无关\n')
    assert.deepEqual(records.problems, [])
    assert.deepEqual(records.reasons.map(reason => [reason.patterns, reason.text]), [
      [['.testcraft/config.json'], '`notTests` 写 `tests/**`，那里不算测试；和 `tests/price.test.ts` 无关'],
    ])
    assert.equal(reasonFor(records, ['tests/price.test.ts'], false), undefined)
    assert.equal(reasonFor(records, ['tests/price.test.ts'], true), undefined)
    assert.equal(reasonFor(records, ['.testcraft/config.json'], true)?.file, RECORD)
  })

  test('行首几个文件用、或逗号隔开都算；只隔空格的下一个反引号算正文', () => {
    const records = read('# feature\n\n## 放水理由\n\n- `testpace.json`、`package.json`, `tests/a/`：整组先不跑格式化测试\n- `src/a.ts` `src/b.ts` 一起改了写法\n')
    assert.deepEqual(records.problems, [])
    assert.deepEqual(records.reasons.map(reason => [reason.patterns, reason.text]), [
      [['testpace.json', 'package.json', 'tests/a/'], '整组先不跑格式化测试'],
      [['src/a.ts'], '`src/b.ts` 一起改了写法'],
    ])
  })

  test('正文里写到通配不算太宽；行首没写文件、只写了文件：都要指出来', () => {
    const records = read('# feature\n\n## 放水理由\n\n- `src/a.ts`：只影响 `*.md` 这类文档\n- 原因在 `src/b.ts` 里写过了\n- `src/c.ts`：\n- `**/*.ts`：全都换了写法\n')
    assert.deepEqual(records.reasons.map(reason => reason.patterns), [['src/a.ts']])
    assert.deepEqual(records.problems, [
      `${RECORD} 第 6 行没写是哪个文件（行首用反引号括起来）`,
      `${RECORD} 第 7 行只写了文件，没写理由`,
      `${RECORD} 第 8 行的 \`**/*.ts\` 太宽：从具体的目录或文件写起`,
    ])
  })

  test('给用户过目和放水理由分开记，写法一样：行首写文件；没写文件、只写了文件、太宽的通配都要指出来', () => {
    const records = read(
      '# feature\n\n## 放水理由\n\n- `tests/a.test.ts`：断言挪到下层\n\n## 给用户过目\n\n- `tests/a.test.ts`、`tests/b/`：原来守着满减，现在由下单流程守\n- 原来守的不变\n- `tests/c.test.ts`：\n- `**`：原来守的都不变\n',
    )
    assert.deepEqual(records.reasons.map(reason => [reason.patterns, reason.text]), [[['tests/a.test.ts'], '断言挪到下层']])
    assert.deepEqual(records.forUser.map(line => [line.patterns, line.text]), [[['tests/a.test.ts', 'tests/b/'], '原来守着满减，现在由下单流程守']])
    assert.equal(forUserLine(records, ['tests/b/x.test.ts'], true)?.text, '原来守着满减，现在由下单流程守')
    assert.equal(forUserLine(records, ['tests/c.test.ts'], false), undefined)
    assert.deepEqual(records.problems, [
      `${RECORD} 第 10 行没写是哪个文件（行首用反引号括起来）`,
      `${RECORD} 第 11 行只写了文件，没写说明`,
      `${RECORD} 第 12 行的 \`**\` 太宽：从具体的目录或文件写起`,
    ])
  })

  test('守的代码取箭头前后的第一个；后面说明里的反引号不算；只写代码位置时不限测试', () => {
    const records = read('# feature\n\n## 守的代码\n\n- `tests/a.test.ts` → `src/a.ts#total`（`total` 是入口）\n- `tests/b.test.ts` -> `src/b.ts`\n- `src/c.ts#discount`（给 `tests/c.test.ts` 用）\n- 没写位置\n')
    assert.deepEqual(records.guards, [
      { path: 'src/a.ts', name: 'total', test: 'tests/a.test.ts', file: RECORD },
      { path: 'src/b.ts', test: 'tests/b.test.ts', file: RECORD },
      { path: 'src/c.ts', name: 'discount', file: RECORD },
    ])
    assert.deepEqual(records.problems, [`${RECORD} 第 8 行没写代码位置（行首用反引号括起来）`])
  })
})
