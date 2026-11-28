// codekeep 的前端规则模板（skills/setup-codekeep/frontend.eslint.mjs）：像项目那样把它接进 eslint 配置，用真的 eslint 查写好的页面代码，看哪一行报了哪一类。
// 模板不预填组件库：像项目那样复制一份、换掉"按项目填"的那几行常量。多数测试用一份 antd 的填法（ANTD_FILL），组件库无关的规则另用 'none' 和别家的名字测。
// 临时目录里的 node_modules 链到 gatelight 装着的那份。

import assert from 'node:assert/strict'
import { readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ESLint, type Linter } from 'eslint'
import { NODE_MODULES, tempDir, write } from './helpers.ts'

const TEMPLATE = fileURLToPath(new URL('../../skills/setup-codekeep/frontend.eslint.mjs', import.meta.url))
const HINT = '（codekeep 前端规则）'
const RESTRICTED = 'no-restricted-syntax'
/** 文字规则（字数、标点、放说明的位置、说明用的横幅）单独一条，只是警告。 */
const TEXT = 'codekeep/text'
const NO_DISABLE = '@eslint-community/eslint-comments/no-restricted-disable'

type Change = Record<string, string>

/**
 * 像项目那样改 LANGUAGES：field 有值时换掉 lang 那一套里的这一项（只认那一套里的）；没有时把 value 整套加进 LANGUAGES，名字叫 lang。
 * value 写成代码。
 */
function language(text: string, lang: string, field: string | undefined, value: string): string {
  if (!field) {
    const start = /^const LANGUAGES = \{$/m
    assert.match(text, start, '模板里没有 LANGUAGES 这一项')
    return text.replace(start, head => `${head}\n  ${lang}: ${value},`)
  }
  const block = new RegExp(`^ {2}${lang}: \\{\\n[\\s\\S]*?^ {2}\\},$`, 'm')
  const [set] = text.match(block) ?? []
  assert.ok(set, `模板的 LANGUAGES 里没有 ${lang} 这一套`)
  const line = new RegExp(`^ {4}${field}: .*,$`, 'm')
  assert.match(set, line, `LANGUAGES.${lang} 里没有 ${field} 这一项`)
  // 正则里有 $，换的时候不能让它当成替换写法
  return text.replace(set, () => set.replace(line, () => `    ${field}: ${value},`))
}

/**
 * 新建一个临时项目目录（node_modules 链好），把换掉了 change 里那几行常量的模板写成 eslint.frontend.mjs。
 * 名字写成 LANGUAGES.<语言>.<项> 的换掉 LANGUAGES 里那一套的一项，写成 LANGUAGES.<语言> 的整套加进去。
 */
function filled(change: Change): { dir: string; file: string } {
  const dir = tempDir('codekeep-frontend-')
  symlinkSync(NODE_MODULES, join(dir, 'node_modules'), 'dir')
  let text = readFileSync(TEMPLATE, 'utf8')
  for (const [name, value] of Object.entries(change)) {
    const [constant, lang, field] = name.split('.')
    if (constant === 'LANGUAGES' && lang) {
      text = language(text, lang, field, value)
      continue
    }
    const line = new RegExp(`^const ${name} = .*$`, 'm')
    assert.match(text, line, `模板里没有 ${name} 这一项`)
    text = text.replace(line, `const ${name} = ${value}`)
  }
  write(dir, 'eslint.frontend.mjs', text)
  return { dir, file: join(dir, 'eslint.frontend.mjs') }
}

/**
 * 一个接好模板的项目：change 是要换掉的"按项目填"的常量（名字 → 新的值，写成代码）。模板不填 UI_LANGUAGE、COMPONENT_LIBRARY 载入就报错，原样用不了。
 * 项目自己的配置只加一项：.ts、.tsx 用 typescript-eslint 的 parser。
 */
function project(change: Change): ESLint {
  const { dir } = filled(change)
  write(
    dir,
    'eslint.config.mjs',
    `import tseslint from 'typescript-eslint'\nimport frontend from './eslint.frontend.mjs'\n\nexport default [\n  { files: ['**/*.{ts,tsx}'], languageOptions: { parser: tseslint.parser } },\n  ...frontend,\n]\n`,
  )
  return new ESLint({ cwd: dir, overrideConfigFile: join(dir, 'eslint.config.mjs') })
}

const MODAL_METHODS = "['confirm', 'info', 'success', 'error', 'warning']"
/** 用 antd 的项目照技能填的组件库那几项，页面文字是中文。 */
const ANTD_FILL: Change = {
  UI_LANGUAGE: "'zh'",
  COMPONENT_LIBRARY: "'antd'",
  DESC_ELEMENTS: "['Typography.Paragraph']",
  DESC_PROPS: "[['Form.Item', 'extra'], ['Form.Item', 'tooltip']]",
  DESC_ANY: "['description']",
  ERROR_BANNERS: "[['Alert', 'type', ['error', 'warning'], 'title']]",
  NOTICE_CALLS: "[['message', ['content']], ['notification', ['message', 'title', 'description']]]",
  CONFIRM_CALLS: `[['Modal', ${MODAL_METHODS}, ['content']], ['modal', ${MODAL_METHODS}, ['content']]]`,
  RULE_MESSAGES: "[['rules', 'message']]",
  ENTRY_PROPS: "[['Popconfirm', 'description'], ['Empty', 'description'], ['Result', 'subTitle']]",
  STYLE_PROPS: "['styles', 'classNames', 'rootClassName', 'offset', 'push', 'pull']",
  UI_CLASS_PROPS: "['classNames', 'rootClassName']",
  THEME_PROVIDERS: "['ConfigProvider']",
  TEXT_PROPS: "[['Modal', 'okText']]",
  VALUE_PROPS: "[['Space', 'size'], ['Col', 'span'], ['Avatar', 'size'], ['Tag', 'color'], ['Modal', 'width']]",
}
/** antd 的填法上再换几项。 */
const antd = (change: Change = {}): ESLint => project({ ...ANTD_FILL, ...change })
/** 没用组件库（COMPONENT_LIBRARY 写 'none'），组件库那几项都空着，页面文字是中文，再换几项。 */
const none = (change: Change = {}): ESLint => project({ UI_LANGUAGE: "'zh'", COMPONENT_LIBRARY: "'none'", ...change })

const ANTD = antd()
const NONE = none()

async function messages(eslint: ESLint, path: string, code: string): Promise<Linter.LintMessage[]> {
  const [result] = await eslint.lintText(code, { filePath: path })
  const fatal = result?.messages.find(message => message.fatal)
  if (fatal) throw new Error(`解析不了 ${path}：${fatal.message}`)
  return result?.messages ?? []
}

const category = (message: Linter.LintMessage): string => message.message.split(/[：（]/)[0] ?? ''

/** 模板的规则（拦下的和文字警告）报了哪些：每条写成"行号 类别"（提示里"："或"（"前面那段）。报错还是警告另在"拦下还是提示"里测。 */
async function lint(path: string, code: string, eslint: ESLint = ANTD): Promise<string[]> {
  return (await messages(eslint, path, code)).filter(message => message.ruleId === RESTRICTED || message.ruleId === TEXT).map(message => `${message.line} ${category(message)}`)
}

const PAGE = 'src/pages/Orders.tsx'
/** 一个页面文件：lines 每项一行，放在组件返回的 <> </> 里（第 2 行起）。 */
const page = (...lines: string[]): string => `export const Page = () => (<>\n${lines.join('\n')}\n</>)\n`

describe('拦下还是提示：文字规则只是警告，结构禁令和写死的值是错误', () => {
  /** 每条写成"行号 类别 规则 级别"（1 警告、2 错误）。 */
  const levels = async (path: string, code: string): Promise<string[]> =>
    (await messages(ANTD, path, code)).filter(message => message.ruleId === RESTRICTED || message.ruleId === TEXT).map(message => `${message.line} ${category(message)} ${message.ruleId} ${message.severity}`)
  const code = [
    "import '../a.css'",
    "import { fake } from './__tests__/fake'",
    'export const Page = () => (<>',
    '<span>一二三四五六七八九十十一二</span>',
    '<span>名称，编号</span>',
    '<p>名称</p>',
    "<Form.Item extra='名称' />",
    "<Alert title='名称' />",
    "<span onClick={() => message.error('保存没成功。请稍后再试')} />",
    '<Col style={s} />',
    '<Space size={4} />',
    "<Tag color='#fff' />",
    '<div />',
    '</>)',
    'export { fake }',
    '',
  ].join('\n')
  const warn = `${TEXT} 1`
  const error = `${RESTRICTED} 2`

  for (const [where, path, styleFile] of [
    ['页面', PAGE, '引样式文件'],
    ['组件层', 'src/ui/Button.tsx', '只引同目录的样式文件'],
  ] as const) {
    test(`${where}：超字数、句子标点、放说明的位置、说明用的横幅、正文不止一句报警告（${TEXT}）；写样式、写死的值、引样式文件、引测试目录、占位报错误`, async () => {
      assert.deepEqual(await levels(path, code), [
        `1 ${styleFile} ${error}`,
        `2 页面不用测试目录里的代码 ${error}`,
        `4 文字超过 12 个字 ${warn}`,
        `5 文字带了句子标点 ${warn}`,
        `6 段落是放说明的 ${warn}`,
        `7 这个参数是放说明的 ${warn}`,
        `8 说明用的横幅 ${warn}`,
        `9 正文不止一句 ${warn}`,
        `10 写样式 ${error}`,
        `11 写死的数字 ${error}`,
        `12 写死的颜色或长度 ${error}`,
        `13 占位 ${error}`,
      ])
    })
  }

  test('就地改主题报错误', async () => {
    assert.deepEqual(await levels(PAGE, page('<ConfigProvider theme={theme}><Button>新建</Button></ConfigProvider>')), [`2 就地改主题 ${error}`])
  })
})

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

  test('写在 JSX 外面的文字不查字数和标点：变量、对象的字段、数组里的、函数参数（含 console）、标签模板，JSX 参数里套在函数调用里的也不查', async () => {
    const code = [
      "export const prompt = '你是一个助手，请根据下面的资料回答用户的问题，不要编造'",
      "export const options = [{ label: '很长很长很长的选项名字啊啊啊' }]",
      "export const load = () => fetch(url).catch(() => console.error('获取失败，请重试'))",
      "export const count = n => format('共有，条记录', n)",
      'export const tip = `保存没成功，${name}请稍后再试。`',
      'export const tagged = t`这是一段写在标签模板里的很长的文字啊`',
      "export const Page = () => <span title={fmt('一二三，四')} onClick={() => track('点了，没反应')}>{prompt}</span>",
      '',
    ].join('\n')
    assert.deepEqual(await lint('src/pages/data.tsx', code), [])
  })

  test('写在 JSX 里的文字照查：JSX 文字、参数直接写的、参数和子元素 {} 里直接写的、二选一、带条件的、再套一层二选一的、模板字符串', async () => {
    assert.deepEqual(
      await lint(
        PAGE,
        page(
          '<span>这是一段写在页面上的很长的说明文字啊</span>',
          '<Select placeholder="选择税率，必填" />',
          "<span>{ok ? '甲，乙' : '乙'}</span>",
          "<span>{ok && '甲，乙'}</span>",
          "<span>{a ? '乙' : b ? '甲，乙' : '丙'}</span>",
          "<span title={ok ? '甲，乙' : '乙'} />",
          '<span title={`甲，${x}`} />',
          "{'甲，乙'}",
        ),
      ),
      ['2 文字超过 12 个字', '3 文字带了句子标点', '4 文字带了句子标点', '5 文字带了句子标点', '6 文字带了句子标点', '7 文字带了句子标点', '8 文字带了句子标点', '9 文字带了句子标点'],
    )
  })

  test('UI_LANGUAGE 写 zh 时不带中文的文字不管：英文多长、带什么标点都不报', async () => {
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
    'App.useApp()、Modal.useModal() 拿到的 modal.confirm 的 content': text => `<span onClick={() => modal.confirm({ title: '删除订单', content: '${text}' })} />`,
    'modal.info/success/error/warning 的 content': text => `<span onClick={() => modal.warning({ content: '${text}' })} />`,
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

  test('写在 JSX 外面的提示、确认框也按正文算：不在组件里的函数照样查', async () => {
    const code = [
      "export const save = () => message.error('保存失败。请重试')",
      `export const warn = () => notification.error({ message: '${LONG}' })`,
      `export const remove = () => Modal.confirm({ title: '删除订单', content: '${OK}' })`,
      '',
    ].join('\n')
    assert.deepEqual(await lint('src/pages/actions.ts', code), ['1 正文不止一句', '2 正文超过 16 个字'])
  })

  test('Modal 别的方法、别的对象的 content、不在 CONFIRM_CALLS 里的对象的 confirm 不算入口：写在 JSX 外面，不查；JSX 参数里不在入口里的二选一按名字查', async () => {
    assert.deepEqual(
      await lint(
        PAGE,
        page(
          `<span onClick={() => Modal.open({ content: '${LONG}' })} />`,
          `<span onClick={() => show({ content: '${LONG}' })} />`,
          `<span onClick={() => other.confirm({ content: '${LONG}' })} />`,
          `<span title={a ? '${OK}' : '无'} />`,
        ),
      ),
      ['5 文字带了句子标点'],
    )
  })

  test('message.*、notification.* 只认直接参数和参数对象里放正文的字段（message 的 content，notification 的 message、title、description）：别的字段、函数参数、更深的对象不算正文，写在 JSX 外面，不查', async () => {
    assert.deepEqual(
      await lint(
        PAGE,
        page(
          `<span onClick={() => notification.warning({ content: '${LONG}' })} />`,
          `<span onClick={() => message.open({ title: '${LONG}' })} />`,
          `<span onClick={() => message.error(fmt('${LONG}'))} />`,
          `<span onClick={() => message.open({ content: fmt('${LONG}') })} />`,
          `<span onClick={() => message.open({ content: { text: '${LONG}' } })} />`,
        ),
      ),
      [],
    )
  })

  test('Modal.confirm 这些只认参数对象直接的 content：content 里的函数参数、回调里别的 content、更深的对象不算正文，写在 JSX 外面，不查', async () => {
    assert.deepEqual(
      await lint(
        PAGE,
        page(
          `<span onClick={() => Modal.confirm({ title: '删除订单', content: fmt('${LONG}') })} />`,
          `<span onClick={() => Modal.confirm({ title: '删除订单', onOk: () => show({ content: '${LONG}' }) })} />`,
          `<span onClick={() => Modal.warning({ footer: { content: '${LONG}' } })} />`,
        ),
      ),
      [],
    )
  })

  test('嵌在入口里的标签、按钮文字按名字查（12 个字、不准句子标点）；入口里的函数参数、数组不算正文，也不查', async () => {
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
      ['2 文字带了句子标点', '3 文字超过 12 个字', '4 文字超过 12 个字', '7 文字带了句子标点'],
    )
  })
})

describe('专门放说明的位置：写了固定文字，短也不准；放数据的不报', () => {
  test('<p> 和 Typography.Paragraph 里写了固定文字报"段落是放说明的"；Typography.Text 不算', async () => {
    assert.deepEqual(await lint(PAGE, page('<p>名称</p>', '<Typography.Paragraph>名称</Typography.Paragraph>', '<Typography.Text>名称</Typography.Text>')), [
      '2 段落是放说明的',
      '3 段落是放说明的',
    ])
  })

  test('段落里放的是数据（变量、字段、图片、数字）或空着：不报；写了固定文字的报在那段文字上：任何一层的 JSX 文字、直接写的字符串、二选一、模板字符串', async () => {
    assert.deepEqual(
      await lint(
        PAGE,
        page(
          '<p>{reply}</p>',
          '<Typography.Paragraph>{item.summary}</Typography.Paragraph>',
          '<p><Image width={100} src={x} /></p>',
          '<p>{3}</p>',
          '<p />',
          '<p>说明</p>',
          '<p><span>嵌套</span></p>',
          "<p>{ok ? '甲' : '乙'}</p>",
          '<p>{`模板 ${x}`}</p>',
          '<Typography.Paragraph>{item.name} 说明</Typography.Paragraph>',
        ),
      ),
      ['7 段落是放说明的', '8 段落是放说明的', '9 段落是放说明的', '9 段落是放说明的', '10 段落是放说明的', '11 段落是放说明的'],
    )
  })

  test('放说明的参数（DESC_PROPS、DESC_ANY）放的是数据不报；写了固定文字的报：直接写的、带条件的、二选一、参数里的标签里写的', async () => {
    assert.deepEqual(
      await lint(
        PAGE,
        page(
          "<Card.Meta title='订单' description={item.address} />",
          "<Card.Meta title='订单' description={<span>{item.city}</span>} />",
          "<Form.Item name='a' extra={hint} />",
          "<Card.Meta title='订单' description='固定' />",
          "<Card.Meta title='订单' description={ok && '固定'} />",
          "<Card.Meta title='订单' description={<span>固定</span>} />",
          "<Form.Item name='a' extra={ok ? '甲' : '乙'} />",
          "<Form.Item name='a' tooltip={<span>固定</span>} />",
        ),
      ),
      ['5 这个参数是放说明的', '6 这个参数是放说明的', '7 这个参数是放说明的', '8 这个参数是放说明的', '8 这个参数是放说明的', '9 这个参数是放说明的'],
    )
    const eslint = none({ DESC_ANY: "['extra']" })
    assert.deepEqual(await lint(PAGE, page("<Card extra='固定' />", '<Card extra={item.extra} />'), eslint), ['2 这个参数是放说明的'])
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

  test('description 属性写了固定文字都报，Popconfirm、Empty 这些入口组件除外；Alert 的 description 照禁，出错横幅也禁', async () => {
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

  test('DESC_PROPS 加上的项目组件 [组件, 参数] 也禁，只禁对得上组件的那个参数、别的组件同名参数不禁；没加的不禁', async () => {
    const code = page("<PageHeader subTitle='名称' />", "<PageHeader hint='名称' />", "<Field help='名称' />", "<Other subTitle='名称' />", "<Other help='名称' />")
    assert.deepEqual(await lint(PAGE, code), [])
    const eslint = antd({ DESC_PROPS: "[['Form.Item', 'extra'], ['Form.Item', 'tooltip'], ['PageHeader', 'subTitle'], ['Field', 'help']]" })
    assert.deepEqual(await lint(PAGE, code, eslint), ['2 这个参数是放说明的', '4 这个参数是放说明的'])
  })
})

describe('项目自己的入口组件（按项目填）', () => {
  test('ENTRY_PROPS 加上的 [组件, 参数] 按正文算、不再按名字算；它的 description 也不再当说明位置禁', async () => {
    const code = page(
      "<ConfirmBar title='删掉后找不回来，要删吗？' />",
      "<ConfirmBar title='删掉后就再也找不回来了请先导出一份' />",
      "<Tip description='删掉后找不回来' />",
      "<OtherBar title='删掉后找不回来，要删吗？' />",
    )
    assert.deepEqual(await lint(PAGE, code), ['2 文字带了句子标点', '3 文字超过 12 个字', '4 这个参数是放说明的', '5 文字带了句子标点'])
    const eslint = antd({ ENTRY_PROPS: "[['Popconfirm', 'description'], ['Empty', 'description'], ['Result', 'subTitle'], ['ConfirmBar', 'title'], ['Tip', 'description']]" })
    assert.deepEqual(await lint(PAGE, code, eslint), ['3 正文超过 16 个字', '5 文字带了句子标点'])
  })

  test('CONFIRM_CALLS 加上的实例名，它的 confirm 这些的 content 按正文算；没加时写在 JSX 外面，不查', async () => {
    const code = page(
      "<span onClick={() => dialog.confirm({ content: '删掉后找不回来，要删吗？' })} />",
      "<span onClick={() => dialog.warning({ content: '删掉后就再也找不回来了请先导出一份' })} />",
      "<span onClick={() => dialog.confirm({ content: '删掉后找不回来。要删吗' })} />",
    )
    assert.deepEqual(await lint(PAGE, code), [])
    assert.deepEqual(await lint(PAGE, code, antd({ CONFIRM_CALLS: `[['Modal', ${MODAL_METHODS}, ['content']], ['modal', ${MODAL_METHODS}, ['content']], ['dialog', ${MODAL_METHODS}, ['content']]]` })), ['3 正文超过 16 个字', '4 正文不止一句'])
  })

  test('ENTRY_CHILDREN 加上的组件，子元素里的文字按正文算', async () => {
    const code = page('<ErrorBar>连不上服务，请稍后再试。</ErrorBar>', '<ErrorBar>连不上服务了请检查网络后再刷新一下</ErrorBar>', '<ErrorBar>连不上服务。请稍后再试</ErrorBar>')
    assert.deepEqual(await lint(PAGE, code), ['2 文字带了句子标点', '3 文字超过 12 个字', '4 文字带了句子标点'])
    assert.deepEqual(await lint(PAGE, code, antd({ ENTRY_CHILDREN: "['ErrorBar']" })), ['3 正文超过 16 个字', '4 正文不止一句'])
  })

  test("ENTRY_CHILDREN 组件的子元素写成 {'…'}、{a ? '…' : '…'}、{a && '…'} 的也按正文算", async () => {
    const code = page(
      "<ErrorBar>{'连不上服务，请稍后再试。'}</ErrorBar>",
      "<ErrorBar>{'连不上服务了请检查网络后再刷新一下'}</ErrorBar>",
      "<ErrorBar>{a ? '连不上服务。请稍后再试' : '已保存'}</ErrorBar>",
      '<ErrorBar>{a && `连不上服务了请检查网络后再刷新一下`}</ErrorBar>',
      "<ErrorBar>{a ? '连不上服务，请稍后再试。' : b ? '没找到订单，请换个条件。' : '已保存'}</ErrorBar>",
    )
    assert.deepEqual(await lint(PAGE, code, antd({ ENTRY_CHILDREN: "['ErrorBar']" })), ['3 正文超过 16 个字', '4 正文不止一句', '5 正文超过 16 个字'])
  })
})

describe('必须原样展示的整段文字（VERBATIM）', () => {
  const ICP = '鄂ICP备2024056407号-2'
  /** 超过名字、正文的字数，中间还有句号：放在哪都会报。 */
  const FOOTER = '版权所有：某某科技（武汉）有限公司。鄂ICP备2024056407号-2'
  const VERBATIM = antd({ VERBATIM: JSON.stringify([ICP, FOOTER]) })
  /** 同一处报了几类时先后不定：排好序比。 */
  const sorted = async (path: string, code: string, eslint?: ESLint): Promise<string[]> => (await lint(path, code, eslint)).sort()

  test('写进 VERBATIM 的整段文字不查字数和标点：JSX 文字、字符串、模板字符串、JSX 文字分几行写都放行', async () => {
    const code = page(`<span>${ICP}</span>`, `<span title='${FOOTER}' />`, `<span>{\`${FOOTER}\`}</span>`, '<span>', `  ${FOOTER}`, '</span>', `<span> ${ICP} </span>`)
    assert.deepEqual(await lint(PAGE, code, VERBATIM), [])
  })

  test('只认整段：后面多加一句、换个号，照常报', async () => {
    assert.deepEqual(
      await sorted(PAGE, page(`<span>${ICP}，备案查询</span>`, '<span>鄂ICP备2024056407号-3</span>', `<span title='${FOOTER}。' />`), VERBATIM),
      ['2 文字带了句子标点', '2 文字超过 12 个字', '3 文字超过 12 个字', '4 文字带了句子标点', '4 文字超过 12 个字'],
    )
  })

  test('默认（VERBATIM 为空）照常报：备案号按名字超过 12 个字', async () => {
    assert.deepEqual(await lint(PAGE, page(`<span>${ICP}</span>`)), ['2 文字超过 12 个字'])
  })

  test('入口（message.error 的正文）也按整段放行；同一处多一句的照常报', async () => {
    const code = page(`<span onClick={() => message.error('${FOOTER}')} />`, `<span onClick={() => message.error('${FOOTER}请稍后再试')} />`)
    assert.deepEqual(await sorted(PAGE, code), ['2 正文不止一句', '2 正文超过 16 个字', '3 正文不止一句', '3 正文超过 16 个字'])
    assert.deepEqual(await sorted(PAGE, code, VERBATIM), ['3 正文不止一句', '3 正文超过 16 个字'])
  })

  test('VERBATIM 里的文字带 /：载入配置时报错', async () => {
    await assert.rejects(lint(PAGE, page('<span>名称</span>'), antd({ VERBATIM: "['京ICP证/000000号']" })), /VERBATIM 里的文字不能带 \//)
  })
})

describe('页面文字的语言（UI_LANGUAGE 写 LANGUAGES 里的一套）', () => {
  /** 一套假的语言：认片假名、按字数，名字 3 个字、正文 5 个字，名字里不准、。 */
  const KATAKANA = String.raw`{ text: '[\\u30a0-\\u30ff]', words: false, name: 3, entry: 5, namePunct: '[、。]', sentence: '。(?!\\s*$)' }`

  test('UI_LANGUAGE 留空（模板默认）时载入配置就报错，说写 LANGUAGES 里的一套', async () => {
    await assert.rejects(lint(PAGE, page('<span>名称</span>'), project({ COMPONENT_LIBRARY: "'antd'" })), /UI_LANGUAGE 写 LANGUAGES 里的一套/)
  })

  test('UI_LANGUAGE 写了 LANGUAGES 里没有的（fr）：载入配置时报错', async () => {
    await assert.rejects(lint(PAGE, page('<span>名称</span>'), antd({ UI_LANGUAGE: "'fr'" })), /UI_LANGUAGE 写 LANGUAGES 里的一套/)
  })

  test('用的那一套语言的正则带 /：载入配置时报错', async () => {
    const slash = "{ text: 'a/b', words: false, name: 3, entry: 5, namePunct: '[、]', sentence: '。' }"
    await assert.rejects(lint(PAGE, page('<span>名称</span>'), antd({ 'LANGUAGES.xx': slash, UI_LANGUAGE: "'xx'" })), /LANGUAGES 里的正则不能带 \//)
  })

  test('LANGUAGES 里自己加一套就按它查：认它的字、按它的上限和标点；中文、英文都不再管', async () => {
    const eslint = antd({ 'LANGUAGES.kana': KATAKANA, UI_LANGUAGE: "'kana'" })
    assert.deepEqual(
      await lint(
        PAGE,
        page(
          '<span>ネコ</span>',
          '<span>カタカナ</span>',
          '<span>ネ、コ</span>',
          "<span onClick={() => message.error('ネコネコネ')} />",
          "<span onClick={() => message.error('ネコネコネコ')} />",
          '<span>一二三四五六七八九十十一二</span>',
          '<span>Show all orders from last week, please.</span>',
        ),
        eslint,
      ),
      ['3 文字超过 3 个字', '4 文字带了句子标点', '6 正文超过 5 个字'],
    )
  })

  test('改 LANGUAGES 里那一套的上限就按改了的查：zh 的 name 改成 20，13 个字的名字不报', async () => {
    const code = page('<span>一二三四五六七八九十十一二</span>', '<span>一二三四五六七八九十十一二三四五六七八九十一</span>')
    assert.deepEqual(await lint(PAGE, code), ['2 文字超过 12 个字', '3 文字超过 12 个字'])
    assert.deepEqual(await lint(PAGE, code, antd({ 'LANGUAGES.zh.name': '20' })), ['3 文字超过 20 个字'])
  })
})

describe('英文页面（UI_LANGUAGE 写 en）', () => {
  const EN = antd({ UI_LANGUAGE: "'en'" })

  test('名字超过 5 个词报"超过 5 个词"；5 个词以内不报', async () => {
    assert.deepEqual(
      await lint(PAGE, page('<span>Show all orders from today</span>', '<span>Show all orders from last week</span>', "<span title='Show all orders from last week' />", '<Button>Save changes</Button>'), EN),
      ['3 文字超过 5 个词', '4 文字超过 5 个词'],
    )
  })

  test('名字里带逗号、括号、后面还有话的冒号、句号报句子标点；末尾一个冒号放行', async () => {
    assert.deepEqual(
      await lint(
        PAGE,
        page(
          '<span>Name, email</span>',
          "<span title='Phone (optional)' />",
          '<span>Note: this cannot be undone</span>',
          '<span>Changes saved.</span>',
          '<span>Are you sure?</span>',
          '<span>Order name:</span>',
          '<span>Name:</span>',
          '<Button>Save changes</Button>',
        ),
        EN,
      ),
      ['2 文字带了句子标点', '3 文字带了句子标点', '4 文字带了句子标点', '5 文字带了句子标点', '6 文字带了句子标点'],
    )
  })

  test('显示文字的参数里不像文字的字符串不当文字查，长了也不报：样式类名、日期格式、全大写的 SQL、带连字符的键、URL、单个词', async () => {
    const code = page(
      "<Tag title='flex items-center gap-2 px-4 py-2 rounded-md shadow-sm' />",
      "<DatePicker placeholder='YYYY-MM-DD HH:mm' />",
      "<Query title='SELECT id FROM users WHERE id = 1' />",
      "<Input placeholder='user-id' />",
      "<a title='https://example.com/orders?page=2&size=20' />",
      "<span title='Internationalization' />",
    )
    assert.deepEqual(await lint(PAGE, code, EN), [])
  })

  test('写在 JSX 外面的不查：标签模板（gql 查询）、变量、对象里的长句；写在 JSX 文字里的长句照报', async () => {
    const code = [
      'export const QUERY = gql`query { user { name email } }`',
      "export const hint = 'Learn more about how billing works here today'",
      "export const options = [{ label: 'Show all orders from last week, please.' }]",
      'export const Page = () => <Learn>Learn more about how billing works here today</Learn>',
      '',
    ].join('\n')
    assert.deepEqual(await lint('src/pages/billing.tsx', code, EN), ['4 文字超过 5 个词'])
  })

  test('入口（message.error）按正文算：10 个词以内、带逗号、末尾句号放行；超过 10 个词报；中间有句号、分号报不止一句', async () => {
    const code = page(
      "<span onClick={() => message.error('Could not save the order, please try it again later.')} />",
      "<span onClick={() => message.error('Could not save the order, please try it again later today.')} />",
      "<span onClick={() => message.error('Saved. Reload the page')} />",
      "<span onClick={() => message.error('Saved; reload the page')} />",
    )
    assert.deepEqual(await lint(PAGE, code, EN), ['3 正文超过 10 个词', '4 正文不止一句', '5 正文不止一句'])
  })

  test('放说明的地方按英文认固定文字：单个词不算文字、不报，两个词以上的报', async () => {
    const code = page('<p>Note</p>', '<p>Learn more</p>', "<Card.Meta title='Order' description='Details' />", "<Card.Meta title='Order' description='Learn more' />")
    assert.deepEqual(await lint(PAGE, code, EN), ['3 段落是放说明的', '5 这个参数是放说明的'])
  })

  test('VERBATIM 里的整段文字照样放行；多一句的照常报', async () => {
    const FOOTER = 'Copyright 2024 Example Inc. All rights reserved.'
    const code = page(`<span>${FOOTER}</span>`, `<span>${FOOTER} Contact us</span>`)
    const sorted = async (eslint: ESLint): Promise<string[]> => (await lint(PAGE, code, eslint)).sort()
    assert.deepEqual(await sorted(EN), ['2 文字带了句子标点', '2 文字超过 5 个词', '3 文字带了句子标点', '3 文字超过 5 个词'])
    assert.deepEqual(await sorted(antd({ UI_LANGUAGE: "'en'", VERBATIM: JSON.stringify([FOOTER]) })), ['3 文字带了句子标点', '3 文字超过 5 个词'])
  })
})

describe('不写具体的值', () => {
  test('管外观的参数写死数字（含负数）报"写死的数字"；写变量不报', async () => {
    assert.deepEqual(await lint(PAGE, page('<Space size={4} />', '<Avatar size={-4} />', '<Space size={size} />')), ['2 写死的数字', '3 写死的数字'])
  })

  test('管外观的参数里的颜色、长度报"写死的颜色或长度"：#fff、#1677ff、12px、-4px、50%、2rem、1.5em、100vh；primary、不带单位的 12 不报', async () => {
    const values = ['#fff', '#1677ff', '12px', '-4px', '50%', '2rem', '1.5em', '100vh']
    assert.deepEqual(
      await lint(PAGE, page(...values.map(value => `<Tag color='${value}' />`), "<Tag color='primary' />", "<Tag size='12' />")),
      values.map((_, index) => `${index + 2} 写死的颜色或长度`),
    )
  })

  test('颜色、长度写在参数的 {} 里、二选一、带条件的也报', async () => {
    assert.deepEqual(
      await lint(
        PAGE,
        page("<Tag color={'#f50'} />", "<Tag color={ok ? '#f50' : '#000'} />", "<Tag color={ok && 'rgb(1, 2, 3)'} />", "<circle fill={a ? '#f50' : b ? 'rgb(1, 2, 3)' : 'none'} />", "<Tag color={ok ? `rgb(${r}, 0, 0)` : 'red'} />"),
      ),
      ['2 写死的颜色或长度', '3 写死的颜色或长度', '3 写死的颜色或长度', '4 写死的颜色或长度', '5 写死的颜色或长度', '5 写死的颜色或长度', '6 写死的颜色或长度'],
    )
  })

  test('写在 JSX 外面的数字、颜色、长度不查：对象里的金额和毛利、字号、税率、锚点、变量里的颜色和拼的长度，JSX 参数里套在函数调用里的', async () => {
    const code = [
      'export const order = { price: 100, margin: 20, gap: 5 }',
      'export const font = { fontSize: 12 }',
      "export const rates = [{ label: '13%' }]",
      "export const anchor = '#feed'",
      "export const c = '#f50'",
      'export const w = `${x}px`',
      "export const Page = () => <Button onClick={() => go('#feed', 12)}>{c}</Button>",
      '',
    ].join('\n')
    assert.deepEqual(await lint('src/pages/data.tsx', code), [])
  })

  test('管外观的参数里的颜色函数（rgb、rgba、hsl、hsla、hwb、lab、lch、oklab、oklch、color）也报，不分大小写；前后的空格不算', async () => {
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
    assert.deepEqual(
      await lint(PAGE, page(...values.map(value => `<Tag color='${value}' />`), "<Tag color='colorful' />", "<Tag color='lab results' />")),
      values.map((_, index) => `${index + 2} 写死的颜色或长度`),
    )
  })

  test('管外观的参数里模板字符串拼的颜色（`rgb(${r}, 0, 0)`）和长度（`${w}px`、rem、vh、vw）也报；不是颜色、长度的拼接不报', async () => {
    const templates = ['`rgb(${r}, 0, 0)`', '`oklch(${l} 0.1 200)`', '`${w}px`', '`${w}rem`', '`${h}vh`', '`${w}vw`', '`${a}-${b}`', '`${count} 个`', '`${w}pixels`']
    assert.deepEqual(await lint(PAGE, page(...templates.map(value => `<Tag color={${value}} />`), '<rect fill={`rgb(${x},0,0)`} strokeWidth={`${x}px`} />')), [
      '2 写死的颜色或长度',
      '3 写死的颜色或长度',
      '4 写死的颜色或长度',
      '5 写死的颜色或长度',
      '6 写死的颜色或长度',
      '7 写死的颜色或长度',
      '11 写死的颜色或长度',
      '11 写死的颜色或长度',
    ])
  })
})

describe('文字和具体的值只查列明的位置', () => {
  test('没列明的参数里的文字不查字数和标点：alt、aria-label、meta 的 content、表单的值 value、name', async () => {
    const code = page(
      "<img alt='一张很长很长的订单截图写在这里给读屏用' />",
      "<button aria-label='点这里，就能把整张表格导出来' />",
      "<meta content='订单管理，查看和导出全部订单' />",
      '<Select.Option value="北京市朝阳区建国路八十八号院一号楼">北京</Select.Option>',
      "<Input name='税率，比如百分之十三' />",
    )
    assert.deepEqual(await lint(PAGE, code), [])
  })

  test('title、label、placeholder 在原生元素和组件上都算显示文字：超过 12 个字、带句子标点报', async () => {
    const code = page(
      "<Input placeholder='税率，比如 13%' />",
      "<Button title='点这里就能把整张表格导出来' />",
      "<Form.Item label='名称，必填' />",
      "<input placeholder='税率，比如 13%' />",
      "<button title='点这里就能把整张表格导出来' />",
      "<option label='名称，必填' />",
    )
    assert.deepEqual(await lint(PAGE, code), ['2 文字带了句子标点', '3 文字超过 12 个字', '4 文字带了句子标点', '5 文字带了句子标点', '6 文字超过 12 个字', '7 文字带了句子标点'])
  })

  test('TEXT_PROPS 列明的 [组件, 参数] 照查：直接写的、写在 {} 里、二选一、带条件的；别的组件上同名的参数不查', async () => {
    const code = page(
      "<Modal okText='确定，马上提交' />",
      "<Modal okText={'确定，马上提交'} />",
      "<Modal okText={ok ? '确定，马上提交' : '确定'} />",
      "<Modal okText={ok && '确定，马上提交'} />",
      "<Drawer okText='确定，马上提交' />",
      "<Modal okText='确定' />",
    )
    assert.deepEqual(await lint(PAGE, code), ['2 文字带了句子标点', '3 文字带了句子标点', '4 文字带了句子标点', '5 文字带了句子标点'])
  })

  test('TEXT_ANY 列明的参数名在任何组件、元素上都查；没填时不查', async () => {
    const code = page("<Modal okText='确定，马上提交' />", "<Drawer okText='确定，马上提交' />", "<dialog okText='确定，马上提交' />")
    assert.deepEqual(await lint(PAGE, code, NONE), [])
    assert.deepEqual(await lint(PAGE, code, none({ TEXT_ANY: "['okText']" })), ['2 文字带了句子标点', '3 文字带了句子标点', '4 文字带了句子标点'])
  })

  test('子元素里直接写的字符串照查：二选一、带条件的', async () => {
    assert.deepEqual(await lint(PAGE, page("<span>{on ? '启用，可以使用' : '停用'}</span>", "<span>{on && '启用，可以使用'}</span>", "<span>{on ? '启用' : '停用'}</span>")), [
      '2 文字带了句子标点',
      '3 文字带了句子标点',
    ])
  })

  test('没列明的参数写数字、颜色、长度不报：pageSize、count、Radio 的 value、title、SVG 的 r、gutter、maxLength、min、level', async () => {
    const code = page(
      '<Table pageSize={20} />',
      '<Badge count={5} />',
      '<Radio value={1} />',
      "<Radio value='13%' />",
      "<span title='#123' />",
      '<circle r={4} />',
      '<Row gutter={-8} />',
      '<Input maxLength={20} />',
      '<InputNumber min={-1} />',
      '<Typography.Title level={2}>订单</Typography.Title>',
    )
    assert.deepEqual(await lint(PAGE, code), [])
  })

  test('SVG 元素上的 fill、stroke、strokeWidth、opacity、fillOpacity、strokeOpacity、fontSize、fontWeight、color 写死的值报', async () => {
    const code = page(
      "<rect fill='#f00' />",
      "<circle fill='#333' />",
      "<line stroke='rgb(1, 2, 3)' />",
      '<rect strokeWidth={2} />',
      '<path opacity={0.5} />',
      '<g fillOpacity={0.5} />',
      '<polygon strokeOpacity={0.3} />',
      '<text fontSize={-1} />',
      '<tspan fontWeight={600} />',
      "<svg color='#f50' />",
    )
    assert.deepEqual(
      await lint(PAGE, code),
      ['2 写死的颜色或长度', '3 写死的颜色或长度', '4 写死的颜色或长度', '5 写死的数字', '6 写死的数字', '7 写死的数字', '8 写死的数字', '9 写死的数字', '10 写死的数字', '11 写死的颜色或长度'],
    )
  })

  test('原生元素的 width、height、size 不算外观、不报：img、canvas、input、select 的，SVG 的 width、height；不在 SVG 清单里的小写元素（react-three-fiber 的材质）上的 color 也不报', async () => {
    const code = page(
      '<img width={220} height={120} />',
      "<img width='220px' />",
      '<canvas width={800} height={600} />',
      '<input size={20} />',
      '<select size={4} />',
      '<svg width={24} height={24} />',
      "<svg width='24px' />",
      '<rect width={10} height={10} />',
      "<meshStandardMaterial color='#f00' />",
      "<font color='#f50' />",
    )
    assert.deepEqual(await lint(PAGE, code), [])
  })

  test('原生元素上的这些参数名写在组件上不算管外观：没列明就不查', async () => {
    const code = page('<Image width={200} />', "<Icon color='#f50' />", "<Chart height={300} fill='#333' />", '<Button size={13} />', "<Drawer width='520px' />")
    assert.deepEqual(await lint(PAGE, code), [])
  })

  test('VALUE_PROPS 列明的 [组件, 参数] 写死的数字、颜色报（二选一里有一个写死的也报）；别的组件上同名的参数不查', async () => {
    const code = page(
      '<Modal width={520} />',
      '<Space size={13} />',
      '<Col span={12} />',
      '<Avatar size={-4} />',
      "<Tag color='#f50' />",
      "<Tag color={on ? '#f50' : 'blue'} />",
      '<Drawer width={520} />',
      '<Row span={12} />',
    )
    assert.deepEqual(await lint(PAGE, code), ['2 写死的数字', '3 写死的数字', '4 写死的数字', '5 写死的数字', '6 写死的颜色或长度', '7 写死的颜色或长度'])
  })

  test('VALUE_ANY 列明的参数名在任何组件上都查；没填时不查', async () => {
    const code = page('<Flex gap={8} />', "<Stack gap='12px' />", '<div gap={8} />')
    assert.deepEqual(await lint(PAGE, code, NONE), [])
    assert.deepEqual(await lint(PAGE, code, none({ VALUE_ANY: "['gap']" })), ['2 写死的数字', '3 写死的颜色或长度', '4 写死的数字'])
  })

  test('管外观的参数写组件给的档位、写变量不报', async () => {
    const code = page("<Space size='small' />", "<Tag color='blue' />", "<Avatar size='large' />", '<Modal width={width} />', "<img width='auto' />")
    assert.deepEqual(await lint(PAGE, code), [])
  })

  test('英文页面也只查列明的位置：title 超过 5 个词、TEXT_PROPS 带逗号报，alt 不查；VALUE_PROPS 写死的数字报，pageSize 和档位不报', async () => {
    const EN = antd({ UI_LANGUAGE: "'en'" })
    const code = page(
      "<Button title='Export the whole table right now' />",
      "<Modal okText='Yes, submit it' />",
      "<img alt='Export the whole table right now, please.' />",
      '<Modal width={520} />',
      '<Pagination pageSize={20} />',
      "<Space size='small' />",
    )
    assert.deepEqual(await lint(PAGE, code, EN), ['2 文字超过 5 个词', '3 文字带了句子标点', '5 写死的数字'])
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

  test('没有属性、没有子元素的空 <div>、<span> 报"占位"；有属性或有内容的不报；<br> 不报', async () => {
    assert.deepEqual(await lint(PAGE, page('<br />', '<div />', '<span></span>', '<div id={id} />', '<span>订单</span>', '<div><Button>新建</Button></div>')), ['3 占位', '4 占位'])
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
    assert.deepEqual(await lint(PAGE, `export const a = 1\n// eslint-disable-next-line ${RESTRICTED}\nexport const B = () => <Tag color='#fff' />\n`), ['3 写死的颜色或长度'])
  })

  test('关文字警告（codekeep/text）的注释也不起作用：违规照样报；关这两条规则的注释本身报错', async () => {
    assert.deepEqual(await lint(PAGE, `/* eslint-disable ${TEXT} */\n${page('<p>名称</p>')}`), ['3 段落是放说明的'])
    assert.deepEqual(await lint(PAGE, `/* eslint ${TEXT}: off */\n${page('<p>名称</p>')}`), ['3 段落是放说明的'])
    const code = `/* eslint-disable ${TEXT} */\n/* eslint-disable ${RESTRICTED} */\n/* eslint-disable no-console */\n${page('<p>名称</p>')}`
    const comments = (await messages(ANTD, PAGE, code)).filter(message => message.ruleId === NO_DISABLE).map(message => `${message.line} ${message.severity}`)
    assert.deepEqual(comments, ['1 2', '2 2'])
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
      await lint(UI, page('<span>一二三四五六七八九十十一二</span>', '<span>名称，编号</span>', '<p>名称</p>', "<Alert title='名称' />", '<Space size={4} />', "<Tag color='#fff' />")),
      ['2 文字超过 12 个字', '3 文字带了句子标点', '4 段落是放说明的', '5 说明用的横幅', '6 写死的数字', '7 写死的颜色或长度'],
    )
  })
})

describe('主题文件', () => {
  test('写颜色、数字都不报', async () => {
    assert.deepEqual(await lint('src/theme.ts', "export const theme = { colorPrimary: '#1677ff', fontSize: 14, padding: 8, shadow: 'rgba(0, 0, 0, 0.45)', width: '12px' }\n"), [])
  })

  test('就地改规则的注释不起作用：主题文件也开着 noInlineConfig', async () => {
    const config = (await ANTD.calculateConfigForFile('src/theme.ts')) as Linter.Config
    assert.equal(config.linterOptions?.noInlineConfig, true)
    assert.deepEqual(await lint('src/theme.ts', `/* eslint ${RESTRICTED}: ["error", "Literal"] */\nexport const theme = { colorPrimary: '#1677ff' }\n`), [])
  })
})

describe('测试文件', () => {
  const BAD = page('<p>名称</p>', '<Space size={4} style={s} />', '<span>名称，编号</span>', '<div />')

  test('*.test.*、*.spec.*、__tests__/ 下的文件，页面规则一条都不报', async () => {
    assert.equal((await lint(PAGE, BAD)).length, 5)
    for (const path of ['src/pages/Orders.test.tsx', 'src/pages/Orders.spec.tsx', 'src/pages/__tests__/Orders.tsx', 'src/ui/__tests__/Button.tsx', 'src/ui/Button.test.tsx']) {
      assert.deepEqual(await lint(path, BAD), [], path)
    }
  })
})

describe('服务端代码（不在 FRONT 里）', () => {
  test('模板里没有 BACK、BACK_SKIP 这两项；服务端代码里 JSX 写的说明、两句的提示都不报（同样的代码放在 FRONT 里照报）', async () => {
    const text = readFileSync(TEMPLATE, 'utf8')
    assert.doesNotMatch(text, /^const BACK(_SKIP)? = /m)
    const code = ["export const Mail = () => <p>你是订单助手，请根据用户的问题先查订单状态。</p>", "export const save = () => message.error('订单号不对；请检查后重新输入')", ''].join('\n')
    assert.deepEqual(await lint('server/orders.tsx', code), [])
    assert.deepEqual((await lint('src/pages/orders.tsx', code)).sort(), ['1 文字带了句子标点', '1 文字超过 12 个字', '1 段落是放说明的', '2 正文不止一句'], '同样的代码放在 FRONT 里照报')
  })
})

describe('COMPONENT_LIBRARY：不填报错，写 none 只有通用规则', () => {
  test('留空（模板默认）时载入配置就报错，说先填 COMPONENT_LIBRARY 和组件库那几项', async () => {
    await assert.rejects(lint(PAGE, page('<span>名称</span>'), project({ UI_LANGUAGE: "'zh'" })), /先填 COMPONENT_LIBRARY 和组件库那几项/)
  })

  test("写 'none' 时通用规则照报：字数、标点、<p>、空的 div/span、style 和 className、SVG 元素上写死的数字和颜色、引样式文件、引测试目录；<br>、img 的宽不报", async () => {
    const code = [
      "import './a.css'",
      "import { fake } from './__tests__/fake'",
      'export const Page = () => (<>',
      '<span>一二三四五六七八九十十一二</span>',
      '<span>名称，编号</span>',
      '<p>名称</p>',
      '<br />',
      '<div />',
      '<span style={s} className={c} />',
      '<rect strokeWidth={4} />',
      "<svg fill='#fff' />",
      '<img width={4} />',
      '</>)',
      'export { fake }',
      '',
    ].join('\n')
    assert.deepEqual(await lint(PAGE, code, NONE), [
      '1 引样式文件',
      '2 页面不用测试目录里的代码',
      '4 文字超过 12 个字',
      '5 文字带了句子标点',
      '6 段落是放说明的',
      '8 占位',
      '9 写样式',
      '9 写样式',
      '10 写死的数字',
      '11 写死的颜色或长度',
    ])
  })

  test("写 'none' 时就地关规则的注释照样不起作用", async () => {
    assert.deepEqual(await lint(PAGE, `/* eslint-disable ${RESTRICTED} */\n${page('<p>名称</p>')}`, NONE), ['3 段落是放说明的'])
    assert.deepEqual(await lint(PAGE, `/* eslint ${RESTRICTED}: off */\n${page('<p>名称</p>')}`, NONE), ['3 段落是放说明的'])
  })

  test("写 'none' 时组件库的写法一个都不认：说明组件和参数、横幅、样式参数、主题提供者不管；提示和确认框、校验里的文字写在 JSX 外面，不查；没列明的 description 不查，title 按名字查", async () => {
    const code = page(
      '<Typography.Paragraph>名称</Typography.Paragraph>',
      "<Form.Item extra='名称' tooltip='名称' />",
      "<Card description='名称' />",
      "<Alert type='info' title='名称' />",
      '<Box sx={s} styles={s} classNames={c} rootClassName={c} offset={o} />',
      '<ConfigProvider theme={t}><Button>新建</Button></ConfigProvider>',
      "<span onClick={() => message.error('保存没成功，请稍后再试。')} />",
      "<span onClick={() => Modal.confirm({ content: '删掉后找不回来，要删吗？' })} />",
      "<Form.Item rules={[{ message: '必填，请输入' }]} />",
      "<Popconfirm description='删掉后找不回来，要删吗？' />",
      "<Popconfirm title='删掉后找不回来，要删吗？' />",
    )
    assert.deepEqual(await lint(PAGE, code, NONE), ['12 文字带了句子标点'])
  })

  test("写 'none' 时组件层、主题文件照原来的规则", async () => {
    const UI = 'src/ui/Button.tsx'
    assert.deepEqual(await lint(UI, page('<button className={c} />', '<Btn style={s} />', '<p>名称</p>', '<rect strokeWidth={4} />'), NONE), ['3 写样式', '4 段落是放说明的', '5 写死的数字'])
    assert.deepEqual(await lint(UI, "import './a.css'\nimport '../b.css'\nexport const a = 1\n", NONE), ['2 只引同目录的样式文件'])
    assert.deepEqual(await lint('src/theme.ts', "export const theme = { colorPrimary: '#1677ff', fontSize: 14 }\n", NONE), [])
  })
})

describe('组件库那几项：按填进去的值起作用，没填的不管（用别家组件库的名字）', () => {
  const OK = '保存没成功，请稍后再试。'
  const LONG = '保存没成功，网络好像断开了请稍后再试'
  /** 同一处报了几类时先后不定：排好序比（只用在 10 行以内的代码上）。 */
  const sorted = async (path: string, code: string, eslint: ESLint): Promise<string[]> => (await lint(path, code, eslint)).sort()

  test('STYLE_PROPS 填了 sx 才报 sx；没填（none、antd 的填法）不报', async () => {
    const code = page('<Box sx={s} />', '<Box css={s} />')
    assert.deepEqual(await lint(PAGE, code, NONE), [])
    assert.deepEqual(await lint(PAGE, code, ANTD), [])
    assert.deepEqual(await lint(PAGE, code, none({ STYLE_PROPS: "['sx']" })), ['2 写样式'])
  })

  test('THEME_PROVIDERS 填了才报页面上就地改主题；组件层里可以包', async () => {
    const code = page('<ThemeProvider theme={t}><Button>新建</Button></ThemeProvider>')
    assert.deepEqual(await lint(PAGE, code, NONE), [])
    const eslint = none({ THEME_PROVIDERS: "['ThemeProvider']" })
    assert.deepEqual(await lint(PAGE, code, eslint), ['2 就地改主题'])
    assert.deepEqual(await lint('src/ui/Root.tsx', code, eslint), [])
  })

  test('ERROR_BANNERS 填了才有出错横幅两条：出错级别的正文按正文算；别的级别、没写级别、级别写两次、带展开写法的报"说明用的横幅"', async () => {
    const code = page(
      `<Callout intent='danger' title='${OK}' />`,
      `<Callout intent='danger' title='${LONG}' />`,
      "<Callout intent='danger' title='保存没成功。请稍后再试' />",
      "<Callout intent='primary' title='名称' />",
      "<Callout title='名称' />",
      "<Callout intent='danger' intent='primary' title='名称' />",
      "<Callout {...props} intent='danger' title='名称' />",
      "<Alert type='info' title='名称' />",
    )
    assert.deepEqual(await sorted(PAGE, code, NONE), ['2 文字带了句子标点', '3 文字带了句子标点', '3 文字超过 12 个字', '4 文字带了句子标点'])
    assert.deepEqual(await lint(PAGE, code, none({ ERROR_BANNERS: "[['Callout', 'intent', ['danger'], 'title']]" })), [
      '3 正文超过 16 个字',
      '4 正文不止一句',
      '5 说明用的横幅',
      '6 说明用的横幅',
      '7 说明用的横幅',
      '8 说明用的横幅',
    ])
  })

  test('DESC_ELEMENTS、DESC_PROPS 填了才禁（MUI 的 FormHelperText、TextField 的 helperText）；DESC_PROPS 只禁对得上的组件', async () => {
    const code = page('<FormHelperText>名称</FormHelperText>', "<TextField helperText='名称' />", "<Select helperText='名称' />")
    assert.deepEqual(await lint(PAGE, code, NONE), [])
    const eslint = none({ DESC_ELEMENTS: "['FormHelperText']", DESC_PROPS: "[['TextField', 'helperText']]" })
    assert.deepEqual(await lint(PAGE, code, eslint), ['2 段落是放说明的', '3 这个参数是放说明的'])
  })

  test('DESC_ANY 里的参数名在任何组件上都算说明；ENTRY_PROPS 里同名参数的那几个组件除外，按正文算（带点的组件名也一样）；都没填时 hint 没列明，不查', async () => {
    const code = page(
      "<TextField hint='名称' />",
      "<Card hint='名称' />",
      `<ConfirmDialog hint='${OK}' />`,
      "<ConfirmDialog hint='删掉后就再也找不回来了请先导出一份' />",
      `<Dialog.Root hint='${OK}' />`,
      "<Dialog.Other hint='名称' />",
      "<EmptyState hint='名称' />",
    )
    assert.deepEqual(await lint(PAGE, code, NONE), [])
    const eslint = none({ DESC_ANY: "['hint']", ENTRY_PROPS: "[['ConfirmDialog', 'hint'], ['Dialog.Root', 'hint'], ['EmptyState', 'body']]" })
    assert.deepEqual(await lint(PAGE, code, eslint), ['2 这个参数是放说明的', '3 这个参数是放说明的', '5 正文超过 16 个字', '7 这个参数是放说明的', '8 这个参数是放说明的'])
  })

  test('NOTICE_CALLS、CONFIRM_CALLS、RULE_MESSAGES 按填的对象、方法、字段认正文：toast(…)、toast.error(…)、modals.openConfirmModal、Controller 的 rules；没填的对象、方法、字段不算正文，写在 JSX 外面，不查', async () => {
    const code = page(
      `<span onClick={() => toast('${OK}')} />`,
      `<span onClick={() => toast('${LONG}')} />`,
      "<span onClick={() => toast('保存没成功。请稍后再试')} />",
      `<span onClick={() => toast.error('${OK}')} />`,
      `<span onClick={() => toast.error('${LONG}')} />`,
      `<span onClick={() => toast.error({ description: '${LONG}' })} />`,
      `<span onClick={() => toast.error({ title: '${LONG}' })} />`,
      `<span onClick={() => modals.openConfirmModal({ title: '${OK}' })} />`,
      `<span onClick={() => modals.openConfirmModal({ title: '${LONG}' })} />`,
      `<span onClick={() => modals.open({ title: '${LONG}' })} />`,
      `<span onClick={() => modals.openConfirmModal({ labels: '${LONG}' })} />`,
      `<Controller rules={{ required: '${OK}' }} />`,
      `<Controller rules={{ required: '${LONG}' }} />`,
      `<Controller rules={{ message: '${LONG}' }} />`,
      `<span onClick={() => message.error('${LONG}')} />`,
    )
    const eslint = none({
      NOTICE_CALLS: "[['toast', ['description']]]",
      CONFIRM_CALLS: "[['modals', ['openConfirmModal'], ['title']]]",
      RULE_MESSAGES: "[['rules', 'required']]",
    })
    assert.deepEqual(await lint(PAGE, code, eslint), ['3 正文超过 16 个字', '4 正文不止一句', '6 正文超过 16 个字', '7 正文超过 16 个字', '10 正文超过 16 个字', '14 正文超过 16 个字'])
  })

  test('组件名带点的照 JSX 里的写法认：DESC_ELEMENTS、DESC_PROPS、ENTRY_PROPS、ENTRY_CHILDREN、THEME_PROVIDERS、ERROR_BANNERS 都只认两段都对上的', async () => {
    const code = page(
      '<Field.HelperText>名称</Field.HelperText>',
      '<HelperText>名称</HelperText>',
      '<Other.HelperText>名称</Other.HelperText>',
      "<Field.Root hint='名称' />",
      "<Root hint='名称' />",
      "<Field.Other hint='名称' />",
      `<Dialog.Body title='${LONG}' />`,
      `<Body title='${OK}' />`,
      `<Toast.Description>${LONG}</Toast.Description>`,
      `<Description>${OK}</Description>`,
      '<Theme.Provider theme={t}><Button>新建</Button></Theme.Provider>',
      '<Provider theme={t}><Button>新建</Button></Provider>',
      `<Alert.Root status='error' title='${LONG}' />`,
      "<Alert.Root status='info' title='名称' />",
      "<Alert status='info' title='名称' />",
    )
    const eslint = none({
      DESC_ELEMENTS: "['Field.HelperText']",
      DESC_PROPS: "[['Field.Root', 'hint']]",
      ENTRY_PROPS: "[['Dialog.Body', 'title']]",
      ENTRY_CHILDREN: "['Toast.Description']",
      THEME_PROVIDERS: "['Theme.Provider']",
      ERROR_BANNERS: "[['Alert.Root', 'status', ['error'], 'title']]",
    })
    assert.deepEqual(await lint(PAGE, code, eslint), [
      '2 段落是放说明的',
      '5 这个参数是放说明的',
      '8 正文超过 16 个字',
      '9 文字带了句子标点',
      '10 正文超过 16 个字',
      '11 文字带了句子标点',
      '12 就地改主题',
      '14 正文超过 16 个字',
      '15 说明用的横幅',
    ])
  })

  test('页面上 style、className 和 STYLE_PROPS 全不准；组件层能用的 class 参数是 className 加上 UI_CLASS_PROPS（MUI 的 sx、classes）', async () => {
    const code = page('<Button style={s} />', '<Button className={c} />', '<Button sx={s} />', '<Button classes={c} />', '<Button variant={v} />')
    const eslint = none({ STYLE_PROPS: "['sx', 'classes']", UI_CLASS_PROPS: "['classes']" })
    assert.deepEqual(await lint(PAGE, code, eslint), ['2 写样式', '3 写样式', '4 写样式', '5 写样式'])
    assert.deepEqual(await lint('src/ui/Button.tsx', code, eslint), ['2 写样式', '4 写样式'])
  })
})

describe('提示文字', () => {
  test('每条报错和警告的提示都带"（codekeep 前端规则）"：页面、组件层的每一条', async () => {
    const eslint = antd({ DESC_PROPS: "[['Form.Item', 'extra'], ['PageHeader', 'hint']]", ENTRY_CHILDREN: "['ErrorBar']" })
    for (const path of [PAGE, 'src/ui/Button.tsx']) {
      const config = (await eslint.calculateConfigForFile(path)) as Linter.Config
      for (const rule of [RESTRICTED, TEXT]) {
        const [, ...entries] = config.rules?.[rule] as [unknown, ...Array<{ message: string }>]
        assert.ok(entries.length > 0, `${path} ${rule}`)
        for (const entry of entries) assert.ok(entry.message.includes(HINT), `${path} ${rule}：${entry.message}`)
      }
    }
  })
})
