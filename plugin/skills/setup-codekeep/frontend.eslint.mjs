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
/** 后台代码；没有就留空。 */
const BACK = []
/** 后台不管的：种子数据、演示数据、测试、迁移。 */
const BACK_SKIP = []
/** 能写数字的参数：和外观无关的。项目自己组件里的（名字最长几个字、最早哪一年）也加进来。 */
const NUMBER_OK = ['maxLength', 'minLength', 'min', 'max', 'rows', 'precision', 'step', 'tabIndex', 'count', 'defaultValue', 'pageSize', 'mouseEnterDelay', 'mouseLeaveDelay', 'duration']
/** 项目自己组件里专门放说明的参数（副标题、帮助文字这类）。确认框、出错和空状态组件的正文参数不放这里，放 ENTRY_PROPS。 */
const DESC_PROPS = []
/** 前端提示：调用的对象名（message.success(...) 这种）。 */
const NOTICE_CALLS = ['message', 'notification']
/** 确认框、出错和空状态的正文：[组件名, 参数名]。项目自己封装的确认框、出错条、空状态组件加进来。 */
const ENTRY_PROPS = [['Popconfirm', 'description'], ['Empty', 'description'], ['Result', 'subTitle']]
/** 正文写在子元素里的项目组件（<ErrorBar>连不上服务</ErrorBar>）。 */
const ENTRY_CHILDREN = []
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

// 入口：写在这几处的文字按正文算（16 个字、一句话），不按名字算
const callee = `CallExpression[callee.object.name=/^(${names(NOTICE_CALLS)})$/]`
const confirm = "CallExpression[callee.object.name='Modal'][callee.property.name=/^(confirm|info|success|error|warning)$/] Property[key.name='content']"
const strings = parent => [`${parent} > Literal`, `${parent} > TemplateLiteral > TemplateElement`]
const ENTRY = [
  `${callee} Literal`,
  `${callee} TemplateElement`,
  ...strings(confirm),
  // 表单校验没过时的那一句
  ...strings("JSXAttribute[name.name='rules'] Property[key.name='message']"),
  ...ENTRY_PROPS.flatMap(([component, prop]) => {
    const attr = `JSXOpeningElement[name.name='${component}'] > JSXAttribute[name.name='${prop}']`
    return [`${attr} > Literal`, ...strings(`${attr} > JSXExpressionContainer`)]
  }),
  ...ENTRY_CHILDREN.map(component => `JSXElement[openingElement.name.name='${component}'] > JSXText`),
]
const notEntry = `:not(${ENTRY.join(', ')})`
const value = { Literal: 'value', TemplateElement: 'value.cooked', JSXText: 'value' }
/** 带中文、超过 max 个字的固定文字，或带了 punct 里的标点：JSX 文字、字符串、模板字符串的每一段。 */
const textRules = (max, punct, tail, what) =>
  Object.entries(value).flatMap(([node, field]) => [
    { selector: `${node}[${field}=/${CJK}/][${field}=${node === 'JSXText' ? `/\\S[^\\n]{${max - 1},}\\S/` : longer(max)}]${tail}`, message: `${what}超过 ${max} 个字` },
    { selector: `${node}[${field}=/${CJK}/][${field}=/${punct}/]${tail}`, message: `${what}带了句子标点` },
  ])
const NAME_HINT = '：页面上只放名字，说明不写；要告诉用户的写进提示、确认框正文或报错（codekeep 前端规则）'
const ENTRY_HINT = '：提示、确认框正文、报错只说一句，说清怎么了、怎么办（codekeep 前端规则）'
const STYLE_HINT = '：组件不合适就告诉用户，不在这里补；具体的值只写在主题和组件层的样式文件里，改要用户同意（codekeep 前端规则）'

const nameText = textRules(NAME_MAX, PUNCT, notEntry, '文字').map(rule => ({ ...rule, message: rule.message + NAME_HINT }))
const entryText = ENTRY.flatMap(entry => {
  const field = entry.endsWith('TemplateElement') ? 'value.cooked' : 'value'
  const max = entry.endsWith('JSXText') ? `/\\S[^\\n]{${ENTRY_MAX - 1},}\\S/` : longer(ENTRY_MAX)
  return [
    { selector: `${entry}[${field}=${max}]`, message: `正文超过 ${ENTRY_MAX} 个字${ENTRY_HINT}` },
    { selector: `${entry}[${field}=/${SENTENCE}/]`, message: `正文不止一句${ENTRY_HINT}` },
  ]
})
const descPlaces = [
  { selector: "JSXOpeningElement[name.name='p']", message: `段落是放说明的${NAME_HINT}` },
  { selector: "JSXOpeningElement > JSXMemberExpression[object.name='Typography'][property.name='Paragraph']", message: `段落是放说明的${NAME_HINT}` },
  { selector: `JSXAttribute[name.name=/^(extra|tooltip${DESC_PROPS.length ? `|${names(DESC_PROPS)}` : ''})$/]`, message: `这个参数是放说明的${NAME_HINT}` },
  {
    selector: `JSXOpeningElement:not([name.name=/^(${names(ENTRY_PROPS.filter(([, prop]) => prop === 'description').map(([component]) => component))})$/]) > JSXAttribute[name.name='description']`,
    message: `这个参数是放说明的${NAME_HINT}`,
  },
  {
    selector: "JSXOpeningElement[name.name='Alert']:not(:has(JSXAttribute[name.name='type'][value.value=/^(error|warning)$/]))",
    message: `说明用的横幅${NAME_HINT}`,
  },
]

const NUMBER = 'Literal[raw=/^\\d/]'
const values = [
  { selector: `JSXAttribute:not([name.name=/^(${names(NUMBER_OK)})$/]) > JSXExpressionContainer > ${NUMBER}`, message: `写死的数字${STYLE_HINT}` },
  { selector: `JSXAttribute:not([name.name=/^(${names(NUMBER_OK)})$/]) > JSXExpressionContainer > UnaryExpression > ${NUMBER}`, message: `写死的数字${STYLE_HINT}` },
  { selector: `Property[key.name=/^(minWidth|maxWidth|minHeight|maxHeight|fontSize|lineHeight|gap|margin\\w*|padding\\w*|zIndex)$/] > ${NUMBER}`, message: `写死的尺寸${STYLE_HINT}` },
  // 表格的列（有 dataIndex 或 render 的对象）：导出表格这类别的 width 不管
  {
    selector: `ObjectExpression:has(> Property[key.name=/^(dataIndex|render)$/]) > Property[key.name='width'] > ${NUMBER}`,
    message: `写死的列宽（用主题里的几档，或不写）${STYLE_HINT}`,
  },
  { selector: 'Literal[value=/^(#[0-9a-fA-F]{3,8}|rgba?\\(|hsla?\\(|-?\\d+(\\.\\d+)?(px|%|rem|em|vh|vw))$/]', message: `写死的颜色或长度${STYLE_HINT}` },
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

const RESTRICTED = 'no-restricted-syntax'
const noDisable = { '@eslint-community/eslint-comments/no-restricted-disable': ['error', RESTRICTED] }
const front = {
  plugins: { '@eslint-community/eslint-comments': comments },
  // 代码里就地关规则、改配置的注释不起作用：要放开只能改配置，codekeep 会问用户
  linterOptions: { noInlineConfig: true },
}

export default [
  // 页面和业务组件：只准用组件和主题给的档位
  {
    ...front,
    files: FRONT,
    ignores: [...THEME, ...UI],
    rules: {
      [RESTRICTED]: [
        'error',
        ...nameText,
        ...entryText,
        ...descPlaces,
        ...values,
        ...channels(),
        { selector: "JSXOpeningElement[name.name='ConfigProvider']", message: `就地改主题${STYLE_HINT}` },
        { selector: STYLE_FILE, message: `引样式文件${STYLE_HINT}` },
      ],
      ...noDisable,
    },
  },
  // 组件层：可以用 className 指向同目录的样式文件、在根上包 ConfigProvider 接主题；不准写行内样式和具体的值
  {
    ...front,
    files: UI.map(dir => `${dir.replace(/\/\*\*$/, '')}/**/*.{ts,tsx,js,jsx}`),
    rules: {
      [RESTRICTED]: [
        'error',
        ...nameText,
        ...entryText,
        ...descPlaces,
        ...values,
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
