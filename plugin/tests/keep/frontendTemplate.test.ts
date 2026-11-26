// codekeep 的前端规则模板（skills/setup-codekeep/frontend.eslint.mjs）：像项目那样把它接进 eslint 配置，用真的 eslint 查写好的页面代码，看哪一行报了哪一类。
// 默认值直接用模板本身；要改"按项目填"的几项时，像项目那样复制一份、换掉那几行常量。临时目录里的 node_modules 链到 gatelight 装着的那份。

import assert from 'node:assert/strict'
import { readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ESLint, type Linter } from 'eslint'
import { NODE_MODULES, tempDir, write } from './helpers.ts'

const TEMPLATE = fileURLToPath(new URL('../../skills/setup-codekeep/frontend.eslint.mjs', import.meta.url))
const HINT = '（codekeep 前端规则）'
const RESTRICTED = 'no-restricted-syntax'

/**
 * 一个接好模板的项目：change 是要换掉的"按项目填"的常量（名字 → 新的值，写成代码）；不换时直接引模板本身。
 * 项目自己的配置只加一项：.ts、.tsx 用 typescript-eslint 的 parser。
 */
function project(change: Record<string, string> = {}): ESLint {
  const dir = tempDir('codekeep-frontend-')
  symlinkSync(NODE_MODULES, join(dir, 'node_modules'), 'dir')
  let from = pathToFileURL(TEMPLATE).href
  if (Object.keys(change).length) {
    let text = readFileSync(TEMPLATE, 'utf8')
    for (const [name, value] of Object.entries(change)) {
      const line = new RegExp(`^const ${name} = .*$`, 'm')
      assert.match(text, line, `模板里没有 ${name} 这一项`)
      text = text.replace(line, `const ${name} = ${value}`)
    }
    write(dir, 'eslint.frontend.mjs', text)
    from = './eslint.frontend.mjs'
  }
  write(
    dir,
    'eslint.config.mjs',
    `import tseslint from 'typescript-eslint'\nimport frontend from '${from}'\n\nexport default [\n  { files: ['**/*.{ts,tsx}'], languageOptions: { parser: tseslint.parser } },\n  ...frontend,\n]\n`,
  )
  return new ESLint({ cwd: dir, overrideConfigFile: join(dir, 'eslint.config.mjs') })
}

const DEFAULT = project()

async function messages(eslint: ESLint, path: string, code: string): Promise<Linter.LintMessage[]> {
  const [result] = await eslint.lintText(code, { filePath: path })
  const fatal = result?.messages.find(message => message.fatal)
  if (fatal) throw new Error(`解析不了 ${path}：${fatal.message}`)
  return result?.messages ?? []
}

/** 模板的规则报了哪些：每条写成"行号 类别"（提示里"："或"（"前面那段）。 */
async function lint(path: string, code: string, eslint: ESLint = DEFAULT): Promise<string[]> {
  return (await messages(eslint, path, code)).filter(message => message.ruleId === RESTRICTED).map(message => `${message.line} ${message.message.split(/[：（]/)[0]}`)
}

const PAGE = 'src/pages/Orders.tsx'
/** 一个页面文件：lines 每项一行，放在组件返回的 <> </> 里（第 2 行起）。 */
const page = (...lines: string[]): string => `export const Page = () => (<>\n${lines.join('\n')}\n</>)\n`

describe('页面上的固定文字只放名字', () => {
  test('带中文的文字超过 12 个字报：JSX 文字、字符串、模板字符串的每一段都算；12 个字以内不报', async () => {
    assert.deepEqual(
      await lint(
        PAGE,
        page(
          '<span>一二三四五六七八九十十一</span>',
          '<span>一二三四五六七八九十十一二</span>',
          "<span title='一二三四五六七八九十十一二' />",
          "<span title='一二三四五六七八九十十一' />",
          '<span title={`一二三四五六七八九十十一二${a}一二三四五六七八九十十一二`} />',
          '<span title={`一二三${a}四五六`} />',
        ),
      ),
      ['3 文字超过 12 个字', '4 文字超过 12 个字', '6 文字超过 12 个字', '6 文字超过 12 个字'],
    )
  })

  test('带句子标点（，。；！？（）和不在末尾的：）报；末尾一个冒号放行', async () => {
    assert.deepEqual(
      await lint(
        PAGE,
        page(
          '<span>名称，编号</span>',
          '<span>已保存。</span>',
          '<span>甲；乙</span>',
          '<span>好！</span>',
          "<span title='好吗？' />",
          "<span title='金额（元）' />",
          '<span>状态：开</span>',
          '<span>不发了：</span>',
          "<span title='名称：' />",
        ),
      ),
      ['2 文字带了句子标点', '3 文字带了句子标点', '4 文字带了句子标点', '5 文字带了句子标点', '6 文字带了句子标点', '7 文字带了句子标点', '8 文字带了句子标点'],
    )
  })

  test('不带中文的文字不管：多长、带什么标点都不报', async () => {
    assert.deepEqual(await lint(PAGE, page('<span>This is a very long english sentence, really.</span>', "<span title='Hello, world! (yes): no.' />")), [])
  })
})

describe('提示、确认框正文、报错按正文算：16 个字、一句话', () => {
  const OK = '保存没成功，请稍后再试。'
  const LONG = '保存没成功，网络好像断开了请稍后再试'
  const TWO = '保存没成功。请稍后再试'
  const SEMI = '保存没成功；请稍后再试'

  /** 同一个入口写三遍：能放行的、超过 16 个字的、两句话的（句号连、分号连）。 */
  const entryCases = async (make: (text: string) => string): Promise<string[]> => lint(PAGE, page(make(OK), make(LONG), make(TWO), make(SEMI)))
  const EXPECTED = ['3 正文超过 16 个字', '4 正文不止一句', '5 正文不止一句']
  const entries: Record<string, (text: string) => string> = {
    'message.* 的文字': text => `<span onClick={() => message.error('${text}')} />`,
    'message.* 的模板字符串': text => `<span onClick={() => message.error(\`${text}\`)} />`,
    'message.* 参数对象的 content': text => `<span onClick={() => message.open({ type: 'error', content: '${text}' })} />`,
    'notification.* 参数对象的 message': text => `<span onClick={() => notification.warning({ message: '${text}' })} />`,
    'notification.* 参数对象的 title': text => `<span onClick={() => notification.error({ title: '${text}' })} />`,
    'notification.* 参数对象的 description': text => `<span onClick={() => notification.error({ message: '保存没成功', description: '${text}' })} />`,
    'message.* 的直接参数写成二选一': text => `<span onClick={() => message.error(a ? '${text}' : '已保存')} />`,
    'Modal.confirm 的 content': text => `<span onClick={() => Modal.confirm({ title: '删除订单', content: '${text}' })} />`,
    'Modal.info/success/error/warning 的 content': text => `<span onClick={() => Modal.warning({ content: '${text}' })} />`,
    '表单 rules 的 message': text => `<Form.Item name='name' rules={[{ required: true, message: '${text}' }]} />`,
    'Popconfirm 的 description': text => `<Popconfirm title='删除订单' description='${text}' />`,
    'Empty 的 description': text => `<Empty description={'${text}'} />`,
    'Result 的 subTitle': text => `<Result title='没找到' subTitle='${text}' />`,
    '出错横幅 Alert（type="error"）的 title': text => `<Alert type='error' title='${text}' />`,
    '出错横幅 Alert（type="warning"）的 title': text => `<Alert type='warning' title={\`${text}\`} />`,
    "出错横幅 Alert（type={'error'}）的 title": text => `<Alert type={'error'} title='${text}' />`,
    'Alert 的 type 写成 error、warning 二选一': text => `<Alert type={late ? 'warning' : 'error'} title='${text}' />`,
    // 入口里的文字写成二选一、带条件的，也按正文算
    '表单 rules 的 message 写成二选一': text => `<Form.Item name='name' rules={[{ required: true, message: a ? '${text}' : '必填' }]} />`,
    'Modal.confirm 的 content 带条件（&&）': text => `<span onClick={() => Modal.confirm({ title: '删除订单', content: a && '${text}' })} />`,
    '出错横幅 Alert 的 title 写成嵌套的二选一': text => `<Alert type='error' title={a ? '保存没成功' : b ? '${text}' : '已保存'} />`,
    'Popconfirm 的 description 带条件（||）': text => `<Popconfirm title='删除订单' description={a || '${text}'} />`,
    'Result 的 subTitle 二选一里写模板字符串': text => `<Result title='没找到' subTitle={a ? \`${text}\` : '没有'} />`,
  }
  for (const [where, make] of Object.entries(entries)) {
    test(`${where}：16 个字以内、带逗号、末尾句号放行；超过 16 个字报；中间有句号或分号报不止一句`, async () => {
      assert.deepEqual(await entryCases(make), EXPECTED)
    })
  }

  test('Modal 别的方法、别的对象的 content、不在入口里的二选一不算入口：按名字查', async () => {
    assert.deepEqual(
      await lint(PAGE, page(`<span onClick={() => Modal.open({ content: '${OK}' })} />`, `<span onClick={() => show({ content: '${OK}' })} />`, `<span title={a ? '${OK}' : '无'} />`)),
      ['2 文字带了句子标点', '3 文字带了句子标点', '4 文字带了句子标点'],
    )
  })

  test('message.*、notification.* 只认直接参数和参数对象里放正文的字段（message 的 content，notification 的 message、title、description）：别的字段、函数参数、更深的对象按名字查', async () => {
    assert.deepEqual(
      await lint(
        PAGE,
        page(
          `<span onClick={() => notification.warning({ content: '${OK}' })} />`,
          `<span onClick={() => message.open({ title: '${OK}' })} />`,
          `<span onClick={() => message.error(fmt('${OK}'))} />`,
          `<span onClick={() => message.open({ content: fmt('${OK}') })} />`,
          `<span onClick={() => message.open({ content: { text: '${OK}' } })} />`,
        ),
      ),
      ['2 文字带了句子标点', '3 文字带了句子标点', '4 文字带了句子标点', '5 文字带了句子标点', '6 文字带了句子标点'],
    )
  })

  test('Modal.confirm 这些只认参数对象直接的 content：content 里的函数参数、回调里别的 content 按名字查', async () => {
    assert.deepEqual(
      await lint(
        PAGE,
        page(
          `<span onClick={() => Modal.confirm({ title: '删除订单', content: fmt('${OK}') })} />`,
          `<span onClick={() => Modal.confirm({ title: '删除订单', onOk: () => show({ content: '${OK}' }) })} />`,
          `<span onClick={() => Modal.warning({ footer: { content: '${OK}' } })} />`,
        ),
      ),
      ['2 文字带了句子标点', '3 文字带了句子标点', '4 文字带了句子标点'],
    )
  })

  test('嵌在入口里的标签、按钮文字、函数参数、数组按名字查（12 个字、不准句子标点）', async () => {
    assert.deepEqual(
      await lint(
        PAGE,
        page(
          "<Result title='没找到' subTitle={ok && <Tag title='没找到订单，请换个条件' />} />",
          "<Result title='没找到' subTitle={ok && <Button>{'这是按钮的名字超过十二个字'}</Button>} />",
          '<Result title=\'没找到\' subTitle={ok && <Button>按钮的名字超过了十二个字啊</Button>} />',
          "<Empty description={x ?? fmt('函数参数里的说明文字写得长')} />",
          "<Empty description={true && ['没有订单。', '先新建']} />",
          "<Alert type='error' title={ok && <Tag title='没找到订单，请换个条件' />} />",
        ),
      ),
      ['2 文字带了句子标点', '3 文字超过 12 个字', '4 文字超过 12 个字', '5 文字超过 12 个字', '6 文字带了句子标点', '7 文字带了句子标点'],
    )
  })
})

describe('专门放说明的位置：短也不准', () => {
  test('<p> 和 Typography.Paragraph 报"段落是放说明的"，一个段落只报一次', async () => {
    assert.deepEqual(await lint(PAGE, page('<p>名称</p>', '<Typography.Paragraph>名称</Typography.Paragraph>', '<Typography.Text>名称</Typography.Text>')), [
      '2 段落是放说明的',
      '3 段落是放说明的',
    ])
  })

  test('Form.Item 的 extra、tooltip 报；Card、Result、Drawer 的 extra 是放按钮的，不报', async () => {
    assert.deepEqual(
      await lint(
        PAGE,
        page("<Form.Item name='a' extra='名称' />", "<Form.Item name='a' tooltip='名称' />", '<Card extra={<Button>新建</Button>} />', '<Result extra={<Button>返回</Button>} />', '<Drawer extra={<Button>保存</Button>} />'),
      ),
      ['2 这个参数是放说明的', '3 这个参数是放说明的'],
    )
  })

  test('description 属性都报，Popconfirm、Empty 这些入口组件除外；Alert 的 description 照禁，出错横幅也禁', async () => {
    assert.deepEqual(
      await lint(
        PAGE,
        page(
          "<Card.Meta title='订单' description='名称' />",
          "<Steps.Step description='名称' />",
          "<Alert type='error' title='保存没成功' description='名称' />",
          "<Popconfirm title='删除订单' description='删掉后找不回来' />",
          "<Empty description='没有订单' />",
        ),
      ),
      ['2 这个参数是放说明的', '3 这个参数是放说明的', '4 这个参数是放说明的'],
    )
  })

  test('不是出错横幅的 Alert 报"说明用的横幅"：没写 type、info、success、type 写成别的表达式、二选一里有 info', async () => {
    assert.deepEqual(
      await lint(
        PAGE,
        page(
          "<Alert title='名称' />",
          "<Alert type='info' title='名称' />",
          "<Alert type='success' title='名称' />",
          "<Alert type={kind} title='名称' />",
          "<Alert type={late ? 'info' : 'error'} title='名称' />",
          "<Alert type='error' title='名称' />",
          "<Alert type={late ? 'warning' : 'error'} title='名称' />",
        ),
      ),
      ['2 说明用的横幅', '3 说明用的横幅', '4 说明用的横幅', '5 说明用的横幅', '6 说明用的横幅'],
    )
  })

  test('Alert 的 type 写了两次、带展开写法（{...x}）的看不出最后是哪种：报"说明用的横幅"，title 按名字算；只写一次的 type={\'error\'} 不报', async () => {
    const TITLE = '保存没成功，请稍后再试。'
    assert.deepEqual(
      await lint(
        PAGE,
        page(
          `<Alert type='error' type='info' title='${TITLE}' />`,
          `<Alert type='error' {...props} title='${TITLE}' />`,
          `<Alert {...props} type='error' title='${TITLE}' />`,
          `<Alert type={'error'} title='${TITLE}' />`,
        ),
      ),
      ['2 说明用的横幅', '2 文字带了句子标点', '3 说明用的横幅', '3 文字带了句子标点', '4 说明用的横幅', '4 文字带了句子标点'],
    )
  })

  test('不是出错横幅的 Alert 的 title 按名字算，不按正文算', async () => {
    assert.deepEqual(await lint(PAGE, page("<Alert type='info' title='保存没成功，请稍后再试。' />")), ['2 说明用的横幅', '2 文字带了句子标点'])
  })

  test('DESC_PROPS 填了的 [组件, 参数] 也禁，只禁对得上组件的那个参数、别的组件同名参数不禁；默认是空的，一个也不禁', async () => {
    const code = page("<PageHeader subTitle='名称' />", "<PageHeader hint='名称' />", "<Field help='名称' />", "<Other subTitle='名称' />", "<Other help='名称' />")
    assert.deepEqual(await lint(PAGE, code), [])
    assert.deepEqual(await lint(PAGE, code, project({ DESC_PROPS: "[['PageHeader', 'subTitle'], ['Field', 'help']]" })), ['2 这个参数是放说明的', '4 这个参数是放说明的'])
  })
})

describe('项目自己的入口组件（按项目填）', () => {
  test('ENTRY_PROPS 加上的 [组件, 参数] 按正文算；它的 description 也不再当说明位置禁', async () => {
    const code = page(
      "<ConfirmBar text='删掉后找不回来，要删吗？' />",
      "<ConfirmBar text='删掉后就再也找不回来了请先导出一份' />",
      "<Tip description='删掉后找不回来' />",
      "<OtherBar text='删掉后找不回来，要删吗？' />",
    )
    assert.deepEqual(await lint(PAGE, code), ['2 文字带了句子标点', '3 文字超过 12 个字', '4 这个参数是放说明的', '5 文字带了句子标点'])
    const eslint = project({ ENTRY_PROPS: "[['Popconfirm', 'description'], ['Empty', 'description'], ['Result', 'subTitle'], ['ConfirmBar', 'text'], ['Tip', 'description']]" })
    assert.deepEqual(await lint(PAGE, code, eslint), ['3 正文超过 16 个字', '5 文字带了句子标点'])
  })

  test('ENTRY_CHILDREN 加上的组件，子元素里的文字按正文算', async () => {
    const code = page('<ErrorBar>连不上服务，请稍后再试。</ErrorBar>', '<ErrorBar>连不上服务了请检查网络后再刷新一下</ErrorBar>', '<ErrorBar>连不上服务。请稍后再试</ErrorBar>')
    assert.deepEqual(await lint(PAGE, code), ['2 文字带了句子标点', '3 文字超过 12 个字', '4 文字带了句子标点'])
    assert.deepEqual(await lint(PAGE, code, project({ ENTRY_CHILDREN: "['ErrorBar']" })), ['3 正文超过 16 个字', '4 正文不止一句'])
  })

  test("ENTRY_CHILDREN 组件的子元素写成 {'…'}、{a ? '…' : '…'}、{a && '…'} 的也按正文算", async () => {
    const code = page(
      "<ErrorBar>{'连不上服务，请稍后再试。'}</ErrorBar>",
      "<ErrorBar>{'连不上服务了请检查网络后再刷新一下'}</ErrorBar>",
      "<ErrorBar>{a ? '连不上服务。请稍后再试' : '已保存'}</ErrorBar>",
      '<ErrorBar>{a && `连不上服务了请检查网络后再刷新一下`}</ErrorBar>',
      "<ErrorBar>{a ? '连不上服务，请稍后再试。' : b ? '没找到订单，请换个条件。' : '已保存'}</ErrorBar>",
    )
    assert.deepEqual(await lint(PAGE, code, project({ ENTRY_CHILDREN: "['ErrorBar']" })), ['3 正文超过 16 个字', '4 正文不止一句', '5 正文超过 16 个字'])
  })
})

describe('不写具体的值', () => {
  test('JSX 属性写死数字（含负数）报"写死的数字"', async () => {
    assert.deepEqual(await lint(PAGE, page('<Space size={4} />', '<Row gutter={-8} />', '<Space size={size} />')), ['2 写死的数字', '3 写死的数字'])
  })

  test('放行名单里的参数写数字不报：maxLength、minLength、min、max、rows、precision、step、tabIndex、count、defaultValue、pageSize、mouseEnterDelay、mouseLeaveDelay、duration、maxCount、level', async () => {
    const allowed = ['maxLength', 'minLength', 'min', 'max', 'rows', 'precision', 'step', 'tabIndex', 'count', 'defaultValue', 'pageSize', 'mouseEnterDelay', 'mouseLeaveDelay', 'duration', 'maxCount', 'level']
    assert.deepEqual(await lint(PAGE, page(...allowed.map(name => `<Input ${name}={3} />`), '<Typography.Title level={2}>订单</Typography.Title>', '<Upload maxCount={3} />', '<InputNumber min={-1} />')), [])
  })

  test('对象里写数字的尺寸报"写死的尺寸"：minWidth、maxWidth、minHeight、maxHeight、fontSize、lineHeight、gap、margin*、padding*、zIndex', async () => {
    const keys = ['minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'fontSize', 'lineHeight', 'gap', 'margin', 'marginTop', 'padding', 'paddingInline', 'zIndex']
    const code = `${keys.map(key => `export const a${key} = { ${key}: 8 }`).join('\n')}\nexport const other = { total: 8, height: size }\n`
    assert.deepEqual(
      await lint('src/pages/sizes.ts', code),
      keys.map((_, index) => `${index + 1} 写死的尺寸`),
    )
  })

  test('width 只在表格列（同一个对象里有 dataIndex 或 render）里报"写死的列宽"；导出表格的 { header, key, width } 不报', async () => {
    const code = [
      "export const columns = [{ title: '名称', dataIndex: 'name', width: 120 }]",
      "export const actions = [{ title: '操作', render: () => null, width: 80 }]",
      "export const sheet = [{ header: '名称', key: 'name', width: 20 }]",
      '',
    ].join('\n')
    assert.deepEqual(await lint('src/pages/columns.ts', code), ['1 写死的列宽', '2 写死的列宽'])
  })

  test('颜色、长度字面量报"写死的颜色或长度"：#fff、#1677ff、12px、-4px、50%、2rem、1.5em、100vh', async () => {
    const values = ['#fff', '#1677ff', '12px', '-4px', '50%', '2rem', '1.5em', '100vh']
    const code = `${values.map((value, index) => `export const v${index} = '${value}'`).join('\n')}\nexport const name = 'primary'\nexport const size = '12'\n`
    assert.deepEqual(
      await lint('src/pages/values.ts', code),
      values.map((_, index) => `${index + 1} 写死的颜色或长度`),
    )
  })

  test('颜色函数（rgb、rgba、hsl、hsla、hwb、lab、lch、oklab、oklch、color）也报，不分大小写；前后的空格不算', async () => {
    const values = [
      'rgba(0, 0, 0, 0.45)',
      'rgb(22, 119, 255)',
      'hsl(210, 50%, 40%)',
      'hsla(210, 50%, 40%, 0.5)',
      'hwb(210 10% 20%)',
      'lab(50% 40 59)',
      'lch(52% 72 50)',
      'oklab(59% 0.1 0.1)',
      'oklch(70% 0.1 200)',
      'color(display-p3 1 0 0)',
      'RGB(1,2,3)',
      'OKLCH(70% 0.1 200)',
      '#FFF',
      '#fff ',
      ' 12px',
      ' rgb(1, 2, 3)',
    ]
    const code = `${values.map((value, index) => `export const v${index} = '${value}'`).join('\n')}\nexport const word = 'colorful'\nexport const lab = 'lab results'\n`
    assert.deepEqual(
      await lint('src/pages/colors.ts', code),
      values.map((_, index) => `${index + 1} 写死的颜色或长度`),
    )
  })

  test('模板字符串拼的颜色（`rgb(${r}, 0, 0)`）和长度（`${w}px`、rem、vh、vw）也报；不是颜色、长度的拼接不报', async () => {
    const code = [
      'export const a = `rgb(${r}, 0, 0)`',
      'export const b = `oklch(${l} 0.1 200)`',
      'export const c = `${w}px`',
      'export const d = `${w}rem`',
      'export const e = `${h}vh`',
      'export const f = `${w}vw`',
      'export const g = `${a}-${b}`',
      'export const h = `${count} 个`',
      'export const i = `${w}pixels`',
      'export const Tag2 = () => <Tag color={`rgb(${x},0,0)`} width={`${x}px`} />',
      '',
    ].join('\n')
    assert.deepEqual(await lint(PAGE, code), ['1 写死的颜色或长度', '2 写死的颜色或长度', '3 写死的颜色或长度', '4 写死的颜色或长度', '5 写死的颜色或长度', '6 写死的颜色或长度', '10 写死的颜色或长度', '10 写死的颜色或长度'])
  })
})

describe('不写样式', () => {
  test('style、className、styles、classNames、rootClassName、offset、push、pull 报"写样式"', async () => {
    const props = ['style', 'className', 'styles', 'classNames', 'rootClassName', 'offset', 'push', 'pull']
    assert.deepEqual(
      await lint(PAGE, page(...props.map(prop => `<Col ${prop}={x} />`), '<Col span={span} />')),
      props.map((_, index) => `${index + 2} 写样式`),
    )
  })

  test('<br> 和没有属性、没有子元素的空 <div>、<span> 报"占位"；有属性或有内容的不报', async () => {
    assert.deepEqual(await lint(PAGE, page('<br />', '<div />', '<span></span>', '<div id={id} />', '<span>订单</span>', '<div><Button>新建</Button></div>')), ['2 占位', '3 占位', '4 占位'])
  })

  test('ConfigProvider 报"就地改主题"', async () => {
    assert.deepEqual(await lint(PAGE, page('<ConfigProvider theme={theme}><Button>新建</Button></ConfigProvider>')), ['2 就地改主题'])
  })

  test('引 .css、.less、.scss、.sass、.styl 报"引样式文件"；引别的不报', async () => {
    const code = "import './a.css'\nimport s from './a.less'\nimport './a.scss'\nimport './a.sass'\nimport './a.styl'\nimport { theme } from '../theme'\nexport { s, theme }\n"
    assert.deepEqual(await lint(PAGE, code), ['1 引样式文件', '2 引样式文件', '3 引样式文件', '4 引样式文件', '5 引样式文件'])
  })
})

describe('页面、组件层不用测试目录里的代码', () => {
  const code = [
    "import Panel from '../components/__tests__/Panel'",
    "import { fake } from './Orders.test'",
    "import { mock } from './mock.spec.tsx'",
    "export { helper } from './__tests__/helper'",
    "export * from '../fixtures.test.js'",
    "export const load = () => import('./__tests__/Lazy')",
    "import { useTest } from './testing'",
    "import contest from './contest'",
    "import { latest } from '../latest.ts'",
    "export * from './spec'",
    'export { Panel, fake, mock, useTest, contest, latest }',
    '',
  ].join('\n')
  const EXPECTED = ['1 页面不用测试目录里的代码', '2 页面不用测试目录里的代码', '3 页面不用测试目录里的代码', '4 页面不用测试目录里的代码', '5 页面不用测试目录里的代码', '6 页面不用测试目录里的代码']

  test('import、动态 import、export from 测试路径（__tests__/、.test、.spec）报；名字里只是带 test、spec 的不报', async () => {
    assert.deepEqual(await lint(PAGE, code), EXPECTED)
  })

  test('组件层也报；测试文件自己引测试目录的不报', async () => {
    assert.deepEqual(await lint('src/ui/Button.tsx', code), EXPECTED)
    assert.deepEqual(await lint('src/pages/__tests__/Orders.tsx', code), [])
  })
})

describe('代码里就地关规则不起作用', () => {
  test('页面里写 eslint-disable、eslint-disable-next-line、/* eslint 规则: off */，违规照样报', async () => {
    assert.deepEqual(await lint(PAGE, `/* eslint-disable ${RESTRICTED} */\n${page('<p>名称</p>')}`), ['3 段落是放说明的'])
    assert.deepEqual(await lint(PAGE, `/* eslint ${RESTRICTED}: off */\n${page('<p>名称</p>')}`), ['3 段落是放说明的'])
    assert.deepEqual(await lint(PAGE, 'export const Page = () => (<>\n{/* eslint-disable-next-line */}\n<p>名称</p>\n</>)\n'), ['3 段落是放说明的'])
    assert.deepEqual(await lint(PAGE, `export const a = 1\n// eslint-disable-next-line ${RESTRICTED}\nexport const b = '#fff'\n`), ['3 写死的颜色或长度'])
  })
})

describe('组件层（UI 目录）', () => {
  const UI = 'src/ui/Button.tsx'

  test('可以写 className、classNames、rootClassName；style 照样报"写样式"', async () => {
    assert.deepEqual(await lint(UI, page('<button className={cls} />', '<Btn classNames={cls} />', '<Btn rootClassName={cls} />', '<Btn style={s} />')), ['5 写样式'])
  })

  test('只准引同目录的样式文件：./a.css 可以；../a.css、./sub/a.css、styles/a.css 报"只引同目录的样式文件"', async () => {
    const code = "import './a.css'\nimport '../a.css'\nimport './sub/a.less'\nimport 'styles/a.scss'\nexport const a = 1\n"
    assert.deepEqual(await lint(UI, code), ['2 只引同目录的样式文件', '3 只引同目录的样式文件', '4 只引同目录的样式文件'])
  })

  test('文字、说明位置、数字、颜色这些规则照样管', async () => {
    assert.deepEqual(
      await lint(UI, page('<span>一二三四五六七八九十十一二</span>', '<span>名称，编号</span>', '<p>名称</p>', "<Alert title='名称' />", '<Space size={4} />', "<Icon color='#fff' />")),
      ['2 文字超过 12 个字', '3 文字带了句子标点', '4 段落是放说明的', '5 说明用的横幅', '6 写死的数字', '7 写死的颜色或长度'],
    )
  })
})

describe('主题文件', () => {
  test('写颜色、数字都不报', async () => {
    assert.deepEqual(await lint('src/theme.ts', "export const theme = { colorPrimary: '#1677ff', fontSize: 14, padding: 8, shadow: 'rgba(0, 0, 0, 0.45)', width: '12px' }\n"), [])
  })

  test('就地改规则的注释不起作用：主题文件也开着 noInlineConfig', async () => {
    const config = (await DEFAULT.calculateConfigForFile('src/theme.ts')) as Linter.Config
    assert.equal(config.linterOptions?.noInlineConfig, true)
    assert.deepEqual(await lint('src/theme.ts', `/* eslint ${RESTRICTED}: ["error", "Literal"] */\nexport const theme = { colorPrimary: '#1677ff' }\n`), [])
  })
})

describe('测试文件', () => {
  const BAD = page('<p>名称</p>', '<Space size={4} style={s} />', '<span>名称，编号</span>', '<br />')

  test('*.test.*、*.spec.*、__tests__/ 下的文件，页面规则一条都不报', async () => {
    assert.equal((await lint(PAGE, BAD)).length, 5)
    for (const path of ['src/pages/Orders.test.tsx', 'src/pages/Orders.spec.tsx', 'src/pages/__tests__/Orders.tsx', 'src/ui/__tests__/Button.tsx', 'src/ui/Button.test.tsx']) {
      assert.deepEqual(await lint(path, BAD), [], path)
    }
  })
})

describe('后台（BACK）', () => {
  const SERVER = 'server/orders.ts'
  const code = [
    "export const a = '订单号不对，请检查后重新输入一遍再提交给我们看看吧'",
    "export const b = '订单号不对，请检查后重新输入一遍再提交给我们看看'",
    "export const c = '订单号不对；请检查'",
    "export const d = '订单号不对。请检查'",
    "export const e = '订单号不对，请检查。'",
    "export const f = { padding: 8, color: '#fff', style: '12px' }",
    '',
  ].join('\n')
  const BACK = { BACK: "['server/**/*.ts']", BACK_SKIP: "['server/seed/**']" }

  test('BACK、OUTPUT 为空（默认）时模板里没有后台、导出那两块', async () => {
    const config = (await import(pathToFileURL(TEMPLATE).href)) as { default: Linter.Config[] }
    assert.deepEqual(
      config.default.map(block => block.files),
      [['src/**/*.{ts,tsx,js,jsx}'], ['src/ui/**/*.{ts,tsx,js,jsx}'], ['src/theme.ts']],
    )
  })

  test('填了以后：带中文的文字超过 24 个字报，用分号或不在末尾的句号连了两句报，逗号可以；样式、数字这些前端规则不管', async () => {
    assert.deepEqual(await lint(SERVER, code, project(BACK)), ['1 文字超过 24 个字', '3 文字带了句子标点', '4 文字带了句子标点'])
  })

  test('BACK_SKIP 里的不查', async () => {
    assert.deepEqual(await lint('server/seed/orders.ts', code, project(BACK)), [])
  })
})

describe('导出、画图的代码（OUTPUT）', () => {
  const POSTER = 'src/export/poster.ts'
  const OUTPUT = project({ OUTPUT: "['src/export/**']" })
  const code = [
    "import './poster.css'",
    "export const columns = [{ title: '名称', dataIndex: 'name', width: 120 }]",
    'export const font = { fontSize: 14, padding: 8 }',
    "export const colors = ['#fff', 'rgba(0, 0, 0, 0.45)', '12px', `${w}px`]",
    "export const tip = '保存没成功，请稍后再试。'",
    "export const sheet = '一二三四五六七八九十十一二'",
    '',
  ].join('\n')
  const OTHERS = ['1 引样式文件', '5 文字带了句子标点', '6 文字超过 12 个字']
  const VALUES = ['2 写死的列宽', '3 写死的尺寸', '3 写死的尺寸', '4 写死的颜色或长度', '4 写死的颜色或长度', '4 写死的颜色或长度', '4 写死的颜色或长度']
  const byLine = (list: string[]): string[] => [...list].sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))

  test('填了以后：这些文件里写死的数字、颜色、长度、尺寸、列宽不报；文字、引样式文件照报', async () => {
    assert.deepEqual(await lint(POSTER, code, OUTPUT), OTHERS)
  })

  test('同一段代码放在页面文件里照报具体的值；OUTPUT 为空（默认）时导出的文件也照报', async () => {
    assert.deepEqual(await lint('src/pages/poster.ts', code, OUTPUT), byLine([...OTHERS, ...VALUES]))
    assert.deepEqual(await lint(POSTER, code), byLine([...OTHERS, ...VALUES]))
  })

  test('不准写 JSX（标签、<></>），每个标签都报；具体的值照旧不查', async () => {
    const jsx = ['export const Size = () => <Space size={4} />', 'export const Hint = () => <><Button>新建</Button></>', "export const fill = '#fff'", ''].join('\n')
    assert.deepEqual(await lint('src/export/Poster.tsx', jsx, OUTPUT), ['1 导出、画图的代码里不写页面组件', '2 导出、画图的代码里不写页面组件', '2 导出、画图的代码里不写页面组件'])
    assert.deepEqual(await lint('src/export/Poster.tsx', jsx), ['1 写死的数字', '3 写死的颜色或长度'], 'OUTPUT 为空时照页面查')
  })

  test('OUTPUT 文件里就地关规则的注释照样不起作用', async () => {
    const tip = "export const tip = '名称，编号'\n"
    assert.deepEqual(await lint(POSTER, `/* eslint-disable ${RESTRICTED} */\n${tip}`, OUTPUT), ['2 文字带了句子标点'])
    assert.deepEqual(await lint(POSTER, `/* eslint ${RESTRICTED}: off */\n${tip}`, OUTPUT), ['2 文字带了句子标点'])
    assert.deepEqual(await lint('src/export/Poster.tsx', `// eslint-disable-next-line ${RESTRICTED}\nexport const P = () => <p />\n`, OUTPUT), ['2 导出、画图的代码里不写页面组件', '2 段落是放说明的'])
  })
})

describe('提示文字', () => {
  test('每条报错的提示都带"（codekeep 前端规则）"：页面、导出、组件层、后台的每一条', async () => {
    const eslint = project({ BACK: "['server/**/*.ts']", OUTPUT: "['src/export/**']", DESC_PROPS: "[['PageHeader', 'hint']]", ENTRY_CHILDREN: "['ErrorBar']" })
    for (const path of [PAGE, 'src/export/Poster.tsx', 'src/ui/Button.tsx', 'server/orders.ts']) {
      const config = (await eslint.calculateConfigForFile(path)) as Linter.Config
      const [, ...entries] = config.rules?.[RESTRICTED] as [unknown, ...Array<{ message: string }>]
      assert.ok(entries.length > 0, path)
      for (const entry of entries) assert.ok(entry.message.includes(HINT), `${path}：${entry.message}`)
    }
  })
})
