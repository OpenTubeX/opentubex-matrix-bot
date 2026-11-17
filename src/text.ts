export const limits = { reportsPerUser: 3, reportsTotal: 20, repliesPerUser: 30 }

export interface Command {
  kind: 'bug' | 'feature' | 'help'
  title: string
  description: string
}

export function parseCommand(text: string): Command | undefined {
  const match = /^!(bug|feature|help)(?![^\s])[ \t]*([^\n]*)\n?([\s\S]*)$/i.exec(text.trim())
  if (!match) return
  return { kind: match[1].toLowerCase() as Command['kind'], title: match[2].trim().slice(0, 256), description: match[3].trim() }
}

// Matrix IDs and pasted handles must not ping GitHub users. Code is left alone, where GitHub
// does not link mentions anyway.
function withoutMentions(text: string) {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, index) => (index % 2 ? part : part.replace(/(^|[^\w`/])@(?=[\w-])/g, '$1@\u2060')))
    .join('')
}

function fit(header: string, text: string) {
  const available = 65_536 - header.length - 100
  const body = text.length > available ? `${text.slice(0, available).replace(/[\uD800-\uDBFF]$/, '')}\n\n> Truncated to fit GitHub.` : text
  return `${header}\n\n${body}`
}

export function issueBody(sender: string, link: string, description: string) {
  return fit(`Reported by \`${sender}\` on [Matrix](${link}).`, description ? withoutMentions(description) : '_No description._')
}

export function commentBody(sender: string, link: string, text: string) {
  return fit(`\`${sender}\` on [Matrix](${link}):`, withoutMentions(text))
}

export const removedReport = {
  title: 'Removed report',
  body: 'The reporter or a moderator removed this report on Matrix.',
}

export function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
}

export interface Notice {
  body: string
  html?: string
}

const newIssue = 'https://github.com/OpenTubeX/OpenTubeX/issues/new/choose'

export const notices = {
  help: {
    body: [
      'Report a bug or request a feature on GitHub without a GitHub account. Start a message with:',
      '',
      '!bug Short summary',
      'What happened, the steps to reproduce it, what you expected, your OpenTubeX version, your operating system, and how you installed OpenTubeX.',
      '',
      '!feature Short summary',
      'What you want and why.',
      '',
      `Your report is posted publicly on GitHub with your Matrix ID. Replies in its thread become comments on GitHub, and GitHub comments show up in the thread. You can file ${limits.reportsPerUser} reports a day.`,
    ].join('\n'),
    html: [
      '<p>Report a bug or request a feature on GitHub without a GitHub account. Start a message with:</p>',
      '<pre><code>!bug Short summary\nWhat happened, the steps to reproduce it, what you expected, your OpenTubeX version, your operating system, and how you installed OpenTubeX.</code></pre>',
      '<pre><code>!feature Short summary\nWhat you want and why.</code></pre>',
      `<p>Your report is posted publicly on GitHub with your Matrix ID. Replies in its thread become comments on GitHub, and GitHub comments show up in the thread. You can file ${limits.reportsPerUser} reports a day.</p>`,
    ].join(''),
  },
  filed: (number: number, url: string): Notice => ({
    body: `Filed as #${number}: ${url}\nReplies in this thread become comments on GitHub, and GitHub comments show up here.`,
    html: `<p>Filed as <a href="${escapeHtml(url)}">#${number}</a>. Replies in this thread become comments on GitHub, and GitHub comments show up here.</p>`,
  }),
  limit: {
    body: `Too many reports today. Try again tomorrow, or file it on GitHub: ${newIssue}`,
    html: `<p>Too many reports today. Try again tomorrow, or <a href="${newIssue}">file it on GitHub</a>.</p>`,
  },
  failed: {
    body: `GitHub rejected this report. Check the title and description, or file it on GitHub: ${newIssue}`,
    html: `<p>GitHub rejected this report. Check the title and description, or <a href="${newIssue}">file it on GitHub</a>.</p>`,
  },
  slow: { body: 'You are sending replies too quickly. I stopped copying them to GitHub for the next hour.' },
  file: { body: 'Files are not copied to GitHub. Describe what it shows, or upload it somewhere public and post the link.' },
} satisfies Record<string, Notice | ((...args: never[]) => Notice)>
