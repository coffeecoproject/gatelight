// codekeep 的前端规则模板（React，和组件库无关）：照 setup-codekeep 技能"有前端代码的项目"一节，复制到项目里（比如 eslint.frontend.mjs），
// 改好"按项目填"的几项（组件库那几项照项目用的组件库的文档填），在 eslint.config.mjs 里 `...frontend` 接进去。只用 eslint 自带的 no-restricted-syntax 和 eslint-comments 插件。
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

/** 必须原样展示的固定文字：备案号、许可证号、公司全称这类，法规或合同要求照录、缩不了的。写准确的整段文字（不能带 /），这几段不查字数和标点；说明文字不放这里。 */
const VERBATIM = []
/** 页面文字用的语言：LANGUAGES 里的一套（'zh'、'en'），别的语言照这两套在 LANGUAGES 里加一套再写它。不填会报错。 */
const UI_LANGUAGE = ''
/**
 * 每种语言怎么认文字、怎么数、哪些标点算句子：
 * text：认得出是给人看的文字的正则（不把 'user-id'、URL、样式类名这类当文字）；words：按词数（true）还是按字数算上限；
 * name、entry：名字、正文的上限；namePunct：名字里不准的标点；sentence：正文不止一句的写法（末尾的句号放行）。
 * 正则里不能有 /（esquery 的正则写不了）。上限是默认值，不用改。
 */
const LANGUAGES = {
  zh: {
    text: '[\\u4e00-\\u9fff]',
    words: false,
    name: 12,
    entry: 16,
    // 末尾的一个冒号（"名称："）放行
    namePunct: '[，。；！？（）]|：(?!\\s*$)',
    sentence: '[；]|。(?!\\s*$)',
  },
  en: {
    // 两个挨着的普通单词，中间可以隔一个标点、括号（全大写的、带连字符的不算：SQL 关键字、样式类名、日期格式）
    text: '(^|\\s)[A-Za-z][a-z]*[,.:;!?]?\\s+\\(?[A-Za-z][a-z]*([\\s.,!?:;)]|$)',
    words: true,
    name: 5,
    entry: 10,
    // 末尾的一个冒号（"Name:"）放行
    namePunct: '[.!?;](\\s|$)|,\\s|[()]|:\\s+\\S',
    sentence: ';|\\.\\s+\\S',
  },
}

// ---- 组件库：照项目用的组件库的文档填（gatelight 不预填哪一家），项目自己封装的组件也填进来。组件名带点的照 JSX 里写（'Form.Item'）----
/** 项目用的组件库（比如 'antd'、'@mui/material'），没用组件库的写 'none'。不填会报错：下面几项要照它的文档填，留空的地方规则就管不到。 */
const COMPONENT_LIBRARY = ''
/** 放说明的元素（段落、帮助文字这类组件）。<p> 已经算了。里面写了固定文字才报，放数据的不报。 */
const DESC_ELEMENTS = []
/** 放说明的参数（副标题、帮助文字、提示气泡这类）：[组件名, 参数名]，写了固定文字就报，放数据的不报。只认组件名对得上的。 */
const DESC_PROPS = []
/** 不管哪个组件上都算说明的参数名（比如 'description'）；ENTRY_PROPS 里同名的那几处按正文算。 */
const DESC_ANY = []
/** 出错条：[组件名, 级别参数, [出错的级别...], 正文参数]。只准标成这几种级别（级别参数只写一次、不用展开写法），正文按正文算；别的级别是放说明的横幅，不准。 */
const ERROR_BANNERS = []
/** 提示：[调用的对象名, [参数对象里放正文的字段...]]（toast('…')、notify.error({ message }) 这种），直接写在参数里的文字也算。 */
const NOTICE_CALLS = []
/** 确认框：[调用的对象名, [方法名...], [参数对象里放正文的字段...]]。用 hook 拿到实例、起了别的名字的，按项目里的名字加。 */
const CONFIRM_CALLS = []
/** 表单校验没过时的那一句：[参数名, 字段名]（写进这个参数的对象里这个字段的文字）。 */
const RULE_MESSAGES = []
/** 确认框、出错和空状态组件的正文：[组件名, 参数名]。 */
const ENTRY_PROPS = []
/** 正文写在子元素里的组件（<ErrorBar>连不上服务</ErrorBar>）。 */
const ENTRY_CHILDREN = []
/** 显示出来的文字参数：[组件名, 参数名]。不管哪个组件上的 title、label、placeholder 已经算了；放说明的、放正文的不写在这里。 */
const TEXT_PROPS = []
/** 不管哪个组件上都是显示出来的文字的参数名（title、label、placeholder 已经算了，比如 'okText'）。 */
const TEXT_ANY = []
/** 管外观的参数：[组件名, 参数名]（间距、尺寸、栅格宽度、颜色这类），里面不准写具体的数字、颜色和长度，写组件给的档位（size="small"）。原生元素上的 width、height 这类已经算了。 */
const VALUE_PROPS = []
/** 不管哪个组件上都只管外观的参数名（这个库里所有组件上的意思都一样才写）。 */
const VALUE_ANY = []
/** style、className 以外能写样式、改布局的参数（各家叫法不同，比如 sx、css、styles、classNames、栅格的 offset），页面上都不准。 */
const STYLE_PROPS = []
/** 组件层里可以指向同目录样式文件的参数：className 以外的（比如 classNames）。 */
const UI_CLASS_PROPS = []
/** 就地改主题的组件（主题提供者）：页面上不准，组件层的根上可以包。 */
const THEME_PROVIDERS = []
// ==== 按项目填完 ====

/** 原生元素上显示出来的文字参数、管外观的参数（HTML、SVG 标准里的）。 */
const HTML_TEXT = ['title', 'label', 'placeholder']
const HTML_VALUES = ['width', 'height', 'size', 'color', 'fill', 'stroke', 'strokeWidth', 'fontSize', 'fontWeight', 'opacity']

const LANG = LANGUAGES[UI_LANGUAGE]
if (!LANG) throw new Error(`codekeep 前端规则：UI_LANGUAGE 写 LANGUAGES 里的一套（${Object.keys(LANGUAGES).join('、')}），别的语言先在 LANGUAGES 里加一套`)
if (Object.values(LANG).some(value => typeof value === 'string' && value.includes('/'))) throw new Error('LANGUAGES 里的正则不能带 /（esquery 的正则写不了）')
if (!COMPONENT_LIBRARY) throw new Error('codekeep 前端规则：先填 COMPONENT_LIBRARY 和组件库那几项（照 setup-codekeep 技能"有前端代码的项目"一节）')

const UNIT = LANG.words ? '词' : '字'
const names = list => list.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
/** 超过 max 个字（词）。JSX 文字按一行算，前后的空白不算。 */
const longer = (max, jsx) => (LANG.words ? `/(\\S+\\s+){${max}}\\S/` : jsx ? `/\\S[^\\n]{${max - 1},}\\S/` : `/^[\\s\\S]{${max + 1},}$/`)
if (VERBATIM.some(text => text.includes('/'))) throw new Error('VERBATIM 里的文字不能带 /（esquery 的正则写不了）')
/** 不是 VERBATIM 里的整段文字（JSX 文字前后的空白不算）。 */
const notVerbatim = field => (VERBATIM.length ? `:not([${field}=/^\\s*(${names(VERBATIM)})\\s*$/])` : '')
/** 按 JSX 里的名字认组件：prefix 是名字所在的位置（开标签上是 ''，整个元素上是 'openingElement.'），带点的（Form.Item）认两段。 */
const named = (prefix, component) => {
  const [object, property] = component.split('.')
  return property ? `[${prefix}name.object.name='${object}'][${prefix}name.property.name='${property}']` : `[${prefix}name.name='${object}']`
}
const opening = component => `JSXOpeningElement${named('', component)}`

// 入口：写在这几处的文字按正文算（LANG.entry 个字、一句话），不按名字算
// 放行只对准那一处：都是直接子节点，不用后代（后代会把嵌在里面的标签、按钮、函数参数也放成正文）
// 写在 parent 下的固定文字：直接写的，和写成二选一（a ? '…' : '…'）、带条件（a && '…'）的，再套一层二选一的也算
const branch = ':matches(ConditionalExpression, LogicalExpression)'
const strings = parent =>
  [parent, `${parent} > ${branch}`, `${parent} > ${branch} > ${branch}`].flatMap(at => [`${at} > Literal`, `${at} > TemplateLiteral > TemplateElement`])
// 出错条：级别只写一次、没有展开写法（{...props}）的才认得出是出错：React 取最后一个值，写两次、展开的看不出最后是哪种
const banners = ERROR_BANNERS.map(([component, levelProp, levels, titleProp]) => {
  const level = `/^(${names(levels)})$/`
  const isError = `JSXAttribute[name.name='${levelProp}']:matches([value.value=${level}], [value.expression.value=${level}], [value.expression.type='ConditionalExpression'][value.expression.consequent.value=${level}][value.expression.alternate.value=${level}])`
  const twice = `JSXAttribute[name.name='${levelProp}'] ~ JSXAttribute[name.name='${levelProp}']`
  return {
    title: `${opening(component)}:has(> ${isError}):not(:has(> JSXSpreadAttribute)):not(:has(> ${twice})) > JSXAttribute[name.name='${titleProp}']`,
    other: `${opening(component)}:matches(:not(:has(> ${isError})), :has(> JSXSpreadAttribute), :has(> ${twice}))`,
  }
})
const ENTRY = [
  ...banners.flatMap(({ title }) => [`${title} > Literal`, ...strings(`${title} > JSXExpressionContainer`)]),
  ...NOTICE_CALLS.flatMap(([object, fields]) => {
    const call = `CallExpression[callee.object.name='${object}']`
    return [...strings(call), ...strings(`${call} > ObjectExpression > Property[key.name=/^(${names(fields)})$/]`)]
  }),
  ...CONFIRM_CALLS.flatMap(([object, methods, fields]) =>
    strings(`CallExpression[callee.object.name='${object}'][callee.property.name=/^(${names(methods)})$/] > ObjectExpression > Property[key.name=/^(${names(fields)})$/]`),
  ),
  ...RULE_MESSAGES.flatMap(([prop, field]) => strings(`JSXAttribute[name.name='${prop}'] Property[key.name='${field}']`)),
  ...ENTRY_PROPS.flatMap(([component, prop]) => {
    const attr = `${opening(component)} > JSXAttribute[name.name='${prop}']`
    return [`${attr} > Literal`, ...strings(`${attr} > JSXExpressionContainer`)]
  }),
  ...ENTRY_CHILDREN.flatMap(component => {
    const element = `JSXElement${named('openingElement.', component)}`
    return [`${element} > JSXText`, ...strings(`${element} > JSXExpressionContainer`)]
  }),
]
const notEntry = ENTRY.length ? `:not(${ENTRY.join(', ')})` : ''
/**
 * 文字和具体的值只查列明的位置：JSX 文字、子元素里直接写的字符串，列明会显示的参数（HTML_TEXT、TEXT_ANY、TEXT_PROPS），
 * 列明管外观的参数（HTML_VALUES、VALUE_ANY、VALUE_PROPS）；都含二选一、带条件的写法。
 * 别处看名字、看长相分不出用途：JSX 外面的变量、对象、函数参数，和没列明的参数（无障碍描述 alt、aria-*，
 * meta 的 content，表单的值 value，分页大小 pageSize）。哪里都查会把它们当成页面文字和样式，逼着改业务内容。
 */
const listed = (native, any, props) => [
  ...(native.length ? [`JSXOpeningElement[name.name=/^[a-z]/] > JSXAttribute[name.name=/^(${names(native)})$/]`] : []),
  ...(any.length ? [`JSXOpeningElement > JSXAttribute[name.name=/^(${names(any)})$/]`] : []),
  ...props.map(([component, prop]) => `${opening(component)} > JSXAttribute[name.name='${prop}']`),
]
const VALUE_ATTRS = listed(HTML_VALUES, VALUE_ANY, VALUE_PROPS)
/** 参数里直接写的字符串（attr="…"、attr={'…'}，含二选一、带条件的）。 */
const inAttrs = attrs => attrs.flatMap(attr => [...strings(attr), ...strings(`${attr} > JSXExpressionContainer`)])
const IN_JSX = ['JSXText', ...strings(':matches(JSXElement, JSXFragment) > JSXExpressionContainer'), ...inAttrs(listed([], [...HTML_TEXT, ...TEXT_ANY], TEXT_PROPS))]
const fieldOf = at => (at.endsWith('TemplateElement') ? 'value.cooked' : 'value')
const NAME_HINT = '：页面上只放名字，说明不写；要告诉用户的写进提示、确认框正文或报错（codekeep 前端规则）'
const ENTRY_HINT = '：提示、确认框正文、报错只说一句，说清怎么了、怎么办（codekeep 前端规则）'
const STYLE_HINT = '：组件不合适就告诉用户，不在这里补；具体的值只写在主题和组件层的样式文件里，改要用户同意（codekeep 前端规则）'

/** 名字：列明的位置（IN_JSX）、认得出是文字（LANG.text）、超过 LANG.name 个字的固定文字，或带了名字里不准的标点。入口那几处除外。 */
const nameText = IN_JSX.flatMap(at => {
  const field = fieldOf(at)
  return [
    { selector: `${at}[${field}=/${LANG.text}/][${field}=${longer(LANG.name, at === 'JSXText')}]${notEntry}${notVerbatim(field)}`, message: `文字超过 ${LANG.name} 个${UNIT}${NAME_HINT}` },
    { selector: `${at}[${field}=/${LANG.text}/][${field}=/${LANG.namePunct}/]${notEntry}${notVerbatim(field)}`, message: `文字带了句子标点${NAME_HINT}` },
  ]
})
const entryText = ENTRY.flatMap(entry => {
  const field = fieldOf(entry)
  return [
    { selector: `${entry}[${field}=${longer(LANG.entry, entry.endsWith('JSXText'))}]${notVerbatim(field)}`, message: `正文超过 ${LANG.entry} 个${UNIT}${ENTRY_HINT}` },
    { selector: `${entry}[${field}=/${LANG.sentence}/]${notVerbatim(field)}`, message: `正文不止一句${ENTRY_HINT}` },
  ]
})
// 放说明的地方只在写了固定文字时报，报在那段文字上：放的是数据（{reply}、{item.address}）的是内容，不是说明。
// 固定文字：认得出是文字（LANG.text）的，里面任何一层的 JSX 文字，或直接写的字符串（含二选一、带条件的）
// 不用 :has(> a > b)：esquery 里它永远不匹配
const fixedIn = (place, children) => [
  `${place} JSXText[value=/${LANG.text}/]`,
  ...strings(children).map(at => `${at}[${fieldOf(at)}=/${LANG.text}/]`),
]
const descText = (places, message) => places.map(selector => ({ selector, message }))
const descPlaces = [
  ...['p', ...DESC_ELEMENTS].flatMap(component => {
    const element = `JSXElement${named('openingElement.', component)}`
    return descText(fixedIn(element, `${element} > JSXExpressionContainer`), `段落是放说明的${NAME_HINT}`)
  }),
  ...DESC_PROPS.flatMap(([component, prop]) => {
    const attr = `${opening(component)} > JSXAttribute[name.name='${prop}']`
    return descText([`${attr} > Literal[value=/${LANG.text}/]`, ...fixedIn(attr, `${attr} > JSXExpressionContainer`)], `这个参数是放说明的${NAME_HINT}`)
  }),
  ...DESC_ANY.flatMap(prop => {
    const entries = ENTRY_PROPS.filter(([, entryProp]) => entryProp === prop).map(([component]) => named('', component))
    const attr = `JSXOpeningElement${entries.length ? `:not(${entries.join(', ')})` : ''} > JSXAttribute[name.name='${prop}']`
    return descText([`${attr} > Literal[value=/${LANG.text}/]`, ...fixedIn(attr, `${attr} > JSXExpressionContainer`)], `这个参数是放说明的${NAME_HINT}`)
  }),
  ...banners.map(({ other }) => ({ selector: other, message: `说明用的横幅${NAME_HINT}` })),
]

const NUMBER = 'Literal[raw=/^\\d/]'
/** 颜色（#fff、rgb()、oklch() 这类，大小写都算）和带单位的长度；前后的空格不算。 */
const COLOR_OR_LENGTH = '/^\\s*(#[0-9a-f]{3,8}|-?\\d+(\\.\\d+)?(px|%|rem|em|vh|vw))\\s*$|^\\s*(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\(/i'
const values = [
  ...VALUE_ATTRS.flatMap(attr => [
    { selector: `${attr} > JSXExpressionContainer > ${NUMBER}`, message: `写死的数字${STYLE_HINT}` },
    { selector: `${attr} > JSXExpressionContainer > UnaryExpression > ${NUMBER}`, message: `写死的数字${STYLE_HINT}` },
  ]),
  // 参数里写的颜色、长度；模板字符串拼的：`rgb(${r}, 0, 0)`、`${width}px`
  ...inAttrs(VALUE_ATTRS).map(at => ({
    selector: at.endsWith('TemplateElement') ? `${at}:matches([value.cooked=${COLOR_OR_LENGTH}], [value.cooked=/^(px|rem|vh|vw)\\b/])` : `${at}[value=${COLOR_OR_LENGTH}]`,
    message: `写死的颜色或长度${STYLE_HINT}`,
  })),
]
const STYLE_FILE = 'ImportDeclaration[source.value=/\\.(css|less|s[ac]ss|styl)$/]'
const channels = (allowed = []) => [
  {
    selector: `JSXAttribute[name.name=/^(${names(['style', 'className', ...STYLE_PROPS].filter(name => !allowed.includes(name)))})$/]`,
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

/** 页面和业务组件的规则。 */
const pageRules = {
  [RESTRICTED]: [
    'error',
    ...nameText,
    ...entryText,
    ...descPlaces,
    ...values,
    fromTests,
    ...channels(),
    ...THEME_PROVIDERS.map(component => ({ selector: opening(component), message: `就地改主题${STYLE_HINT}` })),
    { selector: STYLE_FILE, message: `引样式文件${STYLE_HINT}` },
  ],
  ...noDisable,
}

export default [
  // 页面和业务组件：只准用组件和主题给的档位
  { ...front, files: FRONT, ignores: [...THEME, ...UI, ...TESTS], rules: pageRules },
  // 组件层：可以用 className（和 UI_CLASS_PROPS）指向同目录的样式文件、在根上包主题提供者接主题；不准写行内样式和具体的值
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
        ...channels(['className', ...UI_CLASS_PROPS]),
        { selector: `${STYLE_FILE}:not([source.value=/^\\.\\x2F[^\\x2F]+$/])`, message: `只引同目录的样式文件${STYLE_HINT}` },
      ],
      ...noDisable,
    },
  },
  // 主题：不查值，只不准就地关规则
  { ...front, files: THEME },
]
