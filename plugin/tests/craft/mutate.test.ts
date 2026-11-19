import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { blockOf, byRelevance, mutantsFor, wordsOf } from '../../src/craft/mutate.ts'

describe('改坏哪里', () => {
  test('类型里的尖括号不当比较符改；两边有空格的比较符照改', () => {
    const text = [
      'export function within(db: Kysely<Database>, limit: number): Promise<Array<Row>> {',
      '  return db.count() < limit',
      '}',
    ].join('\n')
    const changes = mutantsFor('src/a.ts', text, [1, 2]).flat().map(m => `${m.line}:${m.before}→${m.after}`)
    assert.ok(!changes.some(c => c.startsWith('1:<') || c.startsWith('1:>')), changes.join(' '))
    assert.ok(changes.includes('2: < → <= '), changes.join(' '))
  })

  test('参数写成多行的函数：一直到函数体结束，函数体里的行都在', () => {
    const text = [
      'export async function remove(args: {', // 1
      '  db: Kysely<Database>;', // 2
      '  input: { id: string };', // 3
      '}): Promise<Result> {', // 4
      '  if (!args.input.id) return null', // 5
      '  return args.db.remove(args.input.id)', // 6
      '}', // 7
      'export function next() {}', // 8
    ].join('\n')
    assert.deepEqual(blockOf(text, 'remove'), [1, 2, 3, 4, 5, 6, 7])
  })

  test('写成 const 的声明（换行再接链式调用）：从声明那行到它结束', () => {
    const text = [
      'export const submitCommandSchema = z', // 1
      '  .object({', // 2
      '    weight: z.number().int().positive().max(200000),', // 3
      '    photos: z.array(z.uuid()).max(9),', // 4
      '  })', // 5
      '  .strict();', // 6
      'export const otherSchema = z.object({})', // 7
    ].join('\n')
    assert.deepEqual(blockOf(text, 'submitCommandSchema'), [1, 2, 3, 4, 5, 6])
  })

  test('泛型参数写成多行的函数：一直到函数体结束，函数体里的行都在', () => {
    const text = [
      'export function plan<', // 1
      '  Identity extends Facts,', // 2
      '  Living extends Record<string, unknown>,', // 3
      '>(args: {', // 4
      '  today: string;', // 5
      '}): Plan {', // 6
      '  if (args.today > limit) return null', // 7
      '  return build(args)', // 8
      '}', // 9
      'export function plainArgs<', // 10
      '  T,', // 11
      '>(', // 12
      '  value: T,', // 13
      '): T {', // 14
      '  return value', // 15
      '}', // 16
      'export function next() {}', // 17
    ].join('\n')
    assert.deepEqual(blockOf(text, 'plan'), [1, 2, 3, 4, 5, 6, 7, 8, 9])
    assert.deepEqual(blockOf(text, 'plainArgs'), [10, 11, 12, 13, 14, 15, 16])
  })

  test('乘除互换，带下划线的数字也改', () => {
    const text = 'export const points = (kept, rate) => Math.floor((kept * rate) / 10_000)'
    const changes = mutantsFor('src/a.ts', text, [1]).flat().map(m => `${m.before}→${m.after}`)
    assert.deepEqual(changes, ['10_000→10001', ' * → / ', ' / → * '])
  })

  test('排序方向倒序、正序对调，排在清空字符串前面', () => {
    const text = [
      '  .orderBy("refund.attempt", "desc")',
      '  sql`order by attempt DESC`',
      "  .orderBy('attempt', 'ASC')",
      "  .orderByRaw('created_at DESC')",
    ].join('\n')
    const first = mutantsFor('src/a.ts', text, [1, 2, 3, 4]).map(([m]) => `${m?.line}:${m?.before}→${m?.after}`)
    assert.deepEqual(first, ['1:"desc"→"asc"', '2:DESC→ASC', "3:'ASC'→'DESC'", '4:DESC→ASC'])
  })

  test('和测试用到的词对得上的行排前面：只在一行出现的词最重，出现的行越多越轻；对不上的照原来的顺序', () => {
    const text = [
      '  .where("refund.organization_id", "=", 1)', // 1
      '  .where("task.organization_id", "=", 2)', // 2
      '  .where("task.kind", "=", 3)', // 3
      '  .orderBy("refund.attempt", "desc")', // 4
      '  .where("store.organization_id", "=", 4)', // 5
      '  .select("photo.v2Key")', // 6：只有一种破坏；数字后面接大写也拆开
    ].join('\n')
    const test = 'refund({ attempt: 2, organizationId: FIXTURE.organizationId, receiptKey })'
    const order = byRelevance(mutantsFor('src/a.ts', text, [1, 2, 3, 4, 5, 6]), text, wordsOf(test)).map(([m]) => m?.line)
    assert.deepEqual(order, [4, 6, 1, 2, 5, 3])
  })
})
