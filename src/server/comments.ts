import os from 'node:os'
import { randomBytes } from 'node:crypto'
import type { CommentMessage, CommentThread } from '../shared/types'
import { gitUser } from './git'
import type { OpenFile, Origin } from './workspace'

// Comment threads on a file: people write them in the editor, agents through
// MCP. Authors are the checkout's git user, or the agent's own name.

export interface Author {
  id: string
  name: string
}

const AGENT: Author = { id: 'agent', name: 'Agent' }

export async function personFor(f: OpenFile): Promise<Author> {
  const { name, email } = f.checkout ? await gitUser(f.checkout) : { name: '', email: '' }
  const login = os.userInfo().username

  return { id: email || login, name: name || login }
}

export function agentNamed(name?: string): Author {
  const n = name?.trim()

  return n ? { id: `agent:${n.toLowerCase()}`, name: n } : AGENT
}

const newId = () => randomBytes(5).toString('hex')

function message(author: Author, text: string): CommentMessage {
  const t = text.trim()

  if (!t) throw new Error('A comment needs some text.')

  return {
    id: newId(),
    authorId: author.id,
    authorName: author.name,
    text: t,
    createdAt: new Date().toISOString(),
  }
}

export function createThread(
  f: OpenFile,
  author: Author,
  at: { pageId: string; nodeId: string | null; x: number; y: number },
  text: string,
  origin: Origin,
): CommentThread {
  if (!f.doc.pages.some((p) => p.id === at.pageId)) throw new Error('That page no longer exists.')

  if (at.nodeId && !f.doc.nodes[at.nodeId]) throw new Error('That layer no longer exists.')
  const first = message(author, text)

  const thread: CommentThread = {
    id: newId(),
    pageId: at.pageId,
    nodeId: at.nodeId,
    x: Math.round(at.x),
    y: Math.round(at.y),
    status: 'open',
    createdAt: first.createdAt,
    messages: [first],
  }

  f.setComments([...f.doc.comments, thread], origin)

  return thread
}

export function reply(
  f: OpenFile,
  author: Author,
  threadId: string,
  text: string,
  origin: Origin,
): CommentMessage {
  const m = message(author, text)
  update(f, threadId, (t) => ({ ...t, messages: [...t.messages, m] }), origin)

  return m
}

export function setStatus(
  f: OpenFile,
  threadId: string,
  status: CommentThread['status'],
  origin: Origin,
) {
  update(f, threadId, (t) => ({ ...t, status }), origin)
}

export function deleteThread(f: OpenFile, threadId: string, origin: Origin) {
  find(f, threadId)
  f.setComments(
    f.doc.comments.filter((t) => t.id !== threadId),
    origin,
  )
}

function find(f: OpenFile, threadId: string): CommentThread {
  const t = f.doc.comments.find((c) => c.id === threadId)

  if (!t) throw new Error(`Comment thread "${threadId}" not found.`)

  return t
}

function update(
  f: OpenFile,
  threadId: string,
  change: (t: CommentThread) => CommentThread,
  origin: Origin,
) {
  find(f, threadId)
  f.setComments(
    f.doc.comments.map((t) => (t.id === threadId ? change(t) : t)),
    origin,
  )
}
