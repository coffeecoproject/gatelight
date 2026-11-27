// codekeep 的前端规则模板（React + antd）：照 setup-codekeep 技能"有前端代码的项目"一节，复制到项目里（比如 eslint.frontend.mjs），
// 改好"按项目填"的几项，在 eslint.config.mjs 里 `...frontend` 接进去。只用 eslint 自带的 no-restricted-syntax 和 eslint-comments 插件。
// 管两件事：页面上不加说明文字；用了组件不在页面里写样式、写具体的值去补。规则是"默认都不准，只放行少数几种"。
// 项目自己的配置里也用了 no-restricted-syntax 的：同一个文件只认最后一份，要把两边的条目合进一份。

import comments from '@eslint-community/eslint-plugin-eslint-comments'

// ==== 按项目填 ====
/** 前端代码（页面、业务组件、组件层、主题都在里面）。 */
const FRONT = ['src/**/*.{ts,tsx,js,jsx}']
/** 主题文件：具体的颜色、尺寸、列宽的几档写在这里。 */
const THEME = ['src/theme.ts']
/** 组件层目录：要自己画的组件和它们同目录的样式文件。 */
const UI = ['src/ui/**']
/** 前端里的测试和测试用的辅助代码：不管。 */
const TESTS = ['**/*.{test,spec}.{ts,tsx,js,jsx}', '**/__tests__/**']
/** 上面那几处在 import 里的写法（正则）：页面不准 import 它们，不然放进测试目录的组件就绕开了规则。TESTS 里加了别的目录的，这里也加上；斜杠写成 \\x2F（规则的写法里不能有 /）。 */
const TEST_IMPORTS = '(^|\\x2F)__tests__(\\x2F|$)|\\.(test|spec)(\\.[cm]?[jt]sx?)?$'

/** 生成下载文件、画图的代码（导出 Excel、canvas 画的海报这类）：做出来的不在页面上，不查具体的值，文字照查；不准写 JSX（页面组件放进来就绕开了）。没有就留空。 */
const OUTPUT = []
/** 后台代码；没有就留空。 */
const BACK = []
/** 后台不管的：种子数据、演示数据、测试、迁移。 */
const BACK_SKIP = []
/** 能写数字的参数：和外观无关的。项目自己组件里的（名字最长几个字、最早哪一年）也加进来。 */
const NUMBER_OK = ['maxLength', 'minLength', 'min', 'max', 'rows', 'precision', 'step', 'tabIndex', 'count', 'defaultValue', 'pageSize', 'mouseEnterDelay', 'mouseLeaveDelay', 'duration', 'maxCount', 'level']
/** 项目自己组件里专门放说明的参数（副标题、帮助文字这类）：[组件名, 参数名]。确认框、出错和空状态组件的正文参数不放这里，放 ENTRY_PROPS。 */
const DESC_PROPS = []
/** 前端提示：[调用的对象名, 参数对象里放正文的字段]（message.success('…')、notification.error({ message, description }) 这种）。直接写在参数里的文字都算。 */
const NOTICE_CALLS = [['message', ['content']], ['notification', ['message', 'title', 'description']]]
/** 确认框的调用对象：静态的 Modal，和 App.useApp()、Modal.useModal() 拿到的实例（项目里给实例起了别的名字的加进来）。 */
const CONFIRM_CALLS = ['Modal', 'modal']
/** 确认框、出错和空状态的正文：[组件名, 参数名]。项目自己封装的确认框、出错条、空状态组件加进来。 */
const ENTRY_PROPS = [['Popconfirm', 'description'], ['Empty', 'description'], ['Result', 'subTitle']]
/** 正文写在子元素里的项目组件（<ErrorBar>连不上服务</ErrorBar>）。 */
const ENTRY_CHILDREN = []
/** 必须原样展示的固定文字：备案号、许可证号、公司全称这类，法规或合同要求照录、缩不了的。写准确的整段文字（不能带 /），这几段不查字数和标点；说明文字不放这里。 */
const VERBATIM = []
/** 名字、正文、后台的字数上限。 */
const NAME_MAX = 12
const ENTRY_MAX = 16
const BACK_MAX = 24
// ==== 按项目填完 ====

const CJK = '[\\u4e00-\\u9fff]'
/** 名字里不准的标点；末尾的一个冒号（"名称：值"）放行。 */
const PUNCT = '[，。；！？（）]|：(?!\\s*$)'
/** 正文只准一句：不准用句号、分号连起来（末尾的句号放行）。 */
const SENTENCE = '[；]|。(?!\\s*$)'
const names = list => list.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
const longer = max => `/^[\\s\\S]{${max + 1},}$/`
if (VERBATIM.some(text => text.includes('/'))) throw new Error('VERBATIM 里的文字不能带 /（esquery 的正则写不了）')
/** 不是 VERBATIM 里的整段文字（JSX 文字前后的空白不算）。 */
const notVerbatim = field => (VERBATIM.length ? `:not([${field}=/^\\s*(${names(VERBATIM)})\\s*$/])` : '')

// 入口：写在这几处的文字按正文算（16 个字、一句话），不按名字算
// 放行只对准那一处：都是直接子节点，不用后代（后代会把嵌在里面的标签、按钮、函数参数也放成正文）
const confirm = `CallExpression[callee.object.name=/^(${names(CONFIRM_CALLS)})$/][callee.property.name=/^(confirm|info|success|error|warning)$/] > ObjectExpression > Property[key.name='content']`
// 写在 parent 下的固定文字：直接写的，和写成二选一（a ? '…' : '…'）、带条件（a && '…'）的，再套一层二选一的也算
const branch = ':matches(ConditionalExpression, LogicalExpression)'
const strings = parent =>
  [parent, `${parent} > ${branch}`, `${parent} > ${branch} > ${branch}`].flatMap(at => [`${at} > Literal`, `${at} > TemplateLiteral > TemplateElement`])
// 出错条：antd 的 Alert 只准 error、warning 两种（写成两者二选一的也算），它的 title 就是出错那一句；description 照样禁。
// type 只写一次、没有展开写法（{...props}）的才算：React 取最后一个值，写两次、展开的看不出最后是哪种
const ERROR_LEVEL = '/^(error|warning)$/'
const errorType = `JSXAttribute[name.name='type']:matches([value.value=${ERROR_LEVEL}], [value.expression.value=${ERROR_LEVEL}], [value.expression.type='ConditionalExpression'][value.expression.consequent.value=${ERROR_LEVEL}][value.expression.alternate.value=${ERROR_LEVEL}])`
const typeTwice = "JSXAttribute[name.name='type'] ~ JSXAttribute[name.name='type']"
const errorAlert = `JSXOpeningElement[name.name='Alert']:has(> ${errorType}):not(:has(> JSXSpreadAttribute)):not(:has(> ${typeTwice}))`
const errorTitle = `${errorAlert} > JSXAttribute[name.name='title']`
const ENTRY = [
  `${errorTitle} > Literal`,
  ...strings(`${errorTitle} > JSXExpressionContainer`),
  ...NOTICE_CALLS.flatMap(([object, fields]) => {
    const call = `CallExpression[callee.object.name='${object}']`
    return [...strings(call), ...strings(`${call} > ObjectExpression > Property[key.name=/^(${names(fields)})$/]`)]
  }),
  ...strings(confirm),
  // 表单校验没过时的那一句
  ...strings("JSXAttribute[name.name='rules'] Property[key.name='message']"),
  ...ENTRY_PROPS.flatMap(([component, prop]) => {
    const attr = `JSXOpeningElement[name.name='${component}'] > JSXAttribute[name.name='${prop}']`
    return [`${attr} > Literal`, ...strings(`${attr} > JSXExpressionContainer`)]
  }),
  ...ENTRY_CHILDREN.flatMap(component => {
    const element = `JSXElement[openingElement.name.name='${component}']`
    return [`${element} > JSXText`, ...strings(`${element} > JSXExpressionContainer`)]
  }),
]
const notEntry = `:not(${ENTRY.join(', ')})`
const value = { Literal: 'value', TemplateElement: 'value.cooked', JSXText: 'value' }
/** 带中文、超过 max 个字的固定文字，或带了 punct 里的标点：JSX 文字、字符串、模板字符串的每一段。 */
const textRules = (max, punct, tail, what) =>
  Object.entries(value).flatMap(([node, field]) => [
    { selector: `${node}[${field}=/${CJK}/][${field}=${node === 'JSXText' ? `/\\S[^\\n]{${max - 1},}\\S/` : longer(max)}]${tail}${notVerbatim(field)}`, message: `${what}超过 ${max} 个字` },
    { selector: `${node}[${field}=/${CJK}/][${field}=/${punct}/]${tail}${notVerbatim(field)}`, message: `${what}带了句子标点` },
  ])
const NAME_HINT = '：页面上只放名字，说明不写；要告诉用户的写进提示、确认框正文或报错（codekeep 前端规则）'
const ENTRY_HINT = '：提示、确认框正文、报错只说一句，说清怎么了、怎么办（codekeep 前端规则）'
const STYLE_HINT = '：组件不合适就告诉用户，不在这里补；具体的值只写在主题和组件层的样式文件里，改要用户同意（codekeep 前端规则）'

const nameText = textRules(NAME_MAX, PUNCT, notEntry, '文字').map(rule => ({ ...rule, message: rule.message + NAME_HINT }))
const entryText = ENTRY.flatMap(entry => {
  const field = entry.endsWith('TemplateElement') ? 'value.cooked' : 'value'
  const max = entry.endsWith('JSXText') ? `/\\S[^\\n]{${ENTRY_MAX - 1},}\\S/` : longer(ENTRY_MAX)
  return [
    { selector: `${entry}[${field}=${max}]${notVerbatim(field)}`, message: `正文超过 ${ENTRY_MAX} 个字${ENTRY_HINT}` },
    { selector: `${entry}[${field}=/${SENTENCE}/]${notVerbatim(field)}`, message: `正文不止一句${ENTRY_HINT}` },
  ]
})
const descPlaces = [
  { selector: "JSXOpeningElement[name.name='p']", message: `段落是放说明的${NAME_HINT}` },
  { selector: "JSXOpeningElement > JSXMemberExpression[object.name='Typography'][property.name='Paragraph']", message: `段落是放说明的${NAME_HINT}` },
  // 表单项的 extra、tooltip 是帮助文字；别的组件的 extra 是放按钮的地方（Card、Result、Drawer），不管
  { selector: "JSXOpeningElement[name.object.name='Form'][name.property.name='Item'] > JSXAttribute[name.name=/^(extra|tooltip)$/]", message: `这个参数是放说明的${NAME_HINT}` },
  ...DESC_PROPS.map(([component, prop]) => ({ selector: `JSXOpeningElement[name.name='${component}'] > JSXAttribute[name.name='${prop}']`, message: `这个参数是放说明的${NAME_HINT}` })),
  {
    selector: `JSXOpeningElement:not([name.name=/^(${names(ENTRY_PROPS.filter(([, prop]) => prop === 'description').map(([component]) => component))})$/]) > JSXAttribute[name.name='description']`,
    message: `这个参数是放说明的${NAME_HINT}`,
  },
  {
    selector: `JSXOpeningElement[name.name='Alert']:matches(:not(:has(> ${errorType})), :has(> JSXSpreadAttribute), :has(> ${typeTwice}))`,
    message: `说明用的横幅${NAME_HINT}`,
  },
]

const NUMBER = 'Literal[raw=/^\\d/]'
/** 颜色（#fff、rgb()、oklch() 这类，大小写都算）和带单位的长度；前后的空格不算。 */
const COLOR_OR_LENGTH = '/^\\s*(#[0-9a-f]{3,8}|-?\\d+(\\.\\d+)?(px|%|rem|em|vh|vw))\\s*$|^\\s*(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\(/i'
const values = [
  { selector: `JSXAttribute:not([name.name=/^(${names(NUMBER_OK)})$/]) > JSXExpressionContainer > ${NUMBER}`, message: `写死的数字${STYLE_HINT}` },
  { selector: `JSXAttribute:not([name.name=/^(${names(NUMBER_OK)})$/]) > JSXExpressionContainer > UnaryExpression > ${NUMBER}`, message: `写死的数字${STYLE_HINT}` },
  { selector: `Property[key.name=/^(minWidth|maxWidth|minHeight|maxHeight|fontSize|lineHeight|gap|margin\\w*|padding\\w*|zIndex)$/] > ${NUMBER}`, message: `写死的尺寸${STYLE_HINT}` },
  // 表格的列（有 dataIndex 或 render 的对象）：导出表格这类别的 width 不管
  {
    selector: `ObjectExpression:has(> Property[key.name=/^(dataIndex|render)$/]) > Property[key.name='width'] > ${NUMBER}`,
    message: `写死的列宽（用主题里的几档，或不写）${STYLE_HINT}`,
  },
  { selector: `Literal[value=${COLOR_OR_LENGTH}]`, message: `写死的颜色或长度${STYLE_HINT}` },
  // 模板字符串拼的：`rgb(${r}, 0, 0)`、`${width}px`
  { selector: `TemplateElement:matches([value.cooked=${COLOR_OR_LENGTH}], [value.cooked=/^(px|rem|vh|vw)\\b/])`, message: `写死的颜色或长度${STYLE_HINT}` },
]
const STYLE_FILE = 'ImportDeclaration[source.value=/\\.(css|less|s[ac]ss|styl)$/]'
const channels = (allowed = []) => [
  {
    selector: `JSXAttribute[name.name=/^(${['style', 'className', 'styles', 'classNames', 'rootClassName', 'offset', 'push', 'pull'].filter(name => !allowed.includes(name)).join('|')})$/]`,
    message: `写样式${STYLE_HINT}`,
  },
  { selector: "JSXOpeningElement[name.name='br']", message: `占位${STYLE_HINT}` },
  { selector: "JSXElement[children.length=0] > JSXOpeningElement[name.name=/^(div|span)$/][attributes.length=0]", message: `占位${STYLE_HINT}` },
]
const fromTests = {
  selector: `:matches(ImportDeclaration, ImportExpression, ExportNamedDeclaration, ExportAllDeclaration)[source.value=/${TEST_IMPORTS}/]`,
  message: '页面不用测试目录里的代码：测试目录不查规则，组件放进去就绕开了（codekeep 前端规则）',
}

const RESTRICTED = 'no-restricted-syntax'
// noInlineConfig 只让这类注释悄悄失效，这条让写了注释的地方直接报错，agent 才知道要改代码而不是换个写法再关。
const noDisable = { '@eslint-community/eslint-comments/no-restricted-disable': ['error', RESTRICTED] }
const front = {
  plugins: { '@eslint-community/eslint-comments': comments },
  // 代码里就地关规则、改配置的注释不起作用：要放开只能改配置，codekeep 会问用户
  linterOptions: { noInlineConfig: true },
}

/** 页面和业务组件的规则；output 为 true 时是导出、画图的代码：不查具体的值，不准写 JSX。 */
const pageRules = output => ({
  [RESTRICTED]: [
    'error',
    ...nameText,
    ...entryText,
    ...descPlaces,
    ...(output ? [{ selector: ':matches(JSXElement, JSXFragment)', message: '导出、画图的代码里不写页面组件：这里不查具体的值，页面上的放回页面目录（codekeep 前端规则）' }] : values),
    fromTests,
    ...channels(),
    { selector: "JSXOpeningElement[name.name='ConfigProvider']", message: `就地改主题${STYLE_HINT}` },
    { selector: STYLE_FILE, message: `引样式文件${STYLE_HINT}` },
  ],
  ...noDisable,
})

export default [
  // 页面和业务组件：只准用组件和主题给的档位
  { ...front, files: FRONT, ignores: [...THEME, ...UI, ...TESTS], rules: pageRules(false) },
  // 导出、画图：做出来的文件和图片不在页面上，具体的值不查
  ...(OUTPUT.length ? [{ ...front, files: OUTPUT, ignores: [...THEME, ...UI, ...TESTS], rules: pageRules(true) }] : []),
  // 组件层：可以用 className 指向同目录的样式文件、在根上包 ConfigProvider 接主题；不准写行内样式和具体的值
  {
    ...front,
    files: UI.map(dir => `${dir.replace(/\/\*\*$/, '')}/**/*.{ts,tsx,js,jsx}`),
    ignores: TESTS,
    rules: {
      [RESTRICTED]: [
        'error',
        ...nameText,
        ...entryText,
        ...descPlaces,
        ...values,
        fromTests,
        ...channels(['className', 'classNames', 'rootClassName']),
        { selector: `${STYLE_FILE}:not([source.value=/^\\.\\x2F[^\\x2F]+$/])`, message: `只引同目录的样式文件${STYLE_HINT}` },
      ],
      ...noDisable,
    },
  },
  // 主题：不查值，只不准就地关规则
  { ...front, files: THEME },
  // 后台：返回给页面的中文 24 个字、一句话
  ...(BACK.length
    ? [
        {
          plugins: front.plugins,
          files: BACK,
          ignores: BACK_SKIP,
          rules: {
            [RESTRICTED]: ['error', ...textRules(BACK_MAX, SENTENCE, '', '文字').map(rule => ({ ...rule, message: `${rule.message}：返回给页面的原因、提示只说一句，说清怎么了、怎么办（codekeep 前端规则）` }))],
            ...noDisable,
          },
        },
      ]
    : []),
]
