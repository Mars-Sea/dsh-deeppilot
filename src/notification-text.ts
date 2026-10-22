/**
 * 通知正文的纯文本投影。
 *
 * 为什么需要：s2c.notify 与 APNs 的 body 是"可直接展示"的文本（PROTOCOL §6），
 * 客户端不得改写；而来源（助手回复、审批原因、提问）都是 Host 给的 Markdown。
 * 直接截原文会把链接地址、URL 编码的中文路径、代码块符号带进锁屏横幅，
 * 所以 Bridge 出站前在这里统一转成纯文本。
 *
 * 只做"去标记、留可读文字"，不追求完整 Markdown 语义；任何无法识别的写法原样保留。
 */

/** 把 Markdown 拆成段落并逐段转为单行纯文本；清洗后为空的段落被丢弃。 */
export function notificationParagraphs(markdown: string): string[] {
  const text = stripCodeFences(markdown.replace(/\r\n?/g, '\n'))
  return text
    .split(/\n[ \t]*\n/)
    .map(plainParagraph)
    .filter((paragraph) => paragraph.length > 0)
}

/**
 * 通知正文：`last` 取最后一个非空段落（任务完成 / 异常结束——回复结尾通常是结论），
 * `all` 把全部段落合成一行（审批原因、提问原文）。长度上限由调用方负责。
 */
export function notificationPlainText(markdown: string, pick: 'last' | 'all'): string {
  const paragraphs = notificationParagraphs(markdown)
  return pick === 'last' ? (paragraphs.at(-1) ?? '') : paragraphs.join(' ')
}

/** 围栏代码块整体丢弃：横幅里放不下代码，留一半反而更难读。未闭合的围栏丢到文末。 */
function stripCodeFences(text: string): string {
  return text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, '\n')
}

function plainParagraph(paragraph: string): string {
  const lines = paragraph
    .split('\n')
    // 表格分隔行与分割线没有文字内容。
    .filter((line) => !(line.includes('|') && line.includes('-') && /^[\s|:-]+$/.test(line)))
    .filter((line) => !/^\s*([*_-])(\s*\1){2,}\s*$/.test(line))
    .map((line) => line
      .replace(/^\s*(>\s?)+/, '')
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
      // 只有以 | 开头的行才当表格行拆格，正文里的竖线保留。
      .replace(/^\s*\|(.*?)\|?\s*$/, (_row, cells: string) => cells.replace(/\s*\|\s*/g, '  ')))
  return decodePercentRuns(stripInline(lines.join(' ')))
    .replace(/\s+/g, ' ')
    .trim()
}

function stripInline(text: string): string {
  return text
    // 图片：alt 文字在横幅里没有意义。
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, '')
    // 行内链接 [文字](地址) 与引用式链接 [文字][id] 只留文字；地址允许一层括号。
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    // 自动链接 <https://…> 去尖括号，剩余 HTML 标签直接去掉。
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    // 行内代码保留内容（常是文件名、命令名），只去反引号。
    .replace(/(`+)([^`]+?)\1/g, '$2')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    // 单个 * / _ 强调要求两侧是非单词字符，避免误伤 snake_case 与乘号。
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
}

/** 正文里残留的 %E6%8F%90 这类编码串解码成原字符；解不开（非法 UTF-8）就保持原样。 */
function decodePercentRuns(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run)
    } catch {
      return run
    }
  })
}
