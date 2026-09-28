import { randomBytes } from 'node:crypto'
import type { Op, PickResult, Proposal, ProposalOption } from '../shared/types'
import type { OpenFile } from './workspace'

// Agents propose alternatives (2 to 4 artboards) for a decision that's the
// user's to make; the user picks one in the editor and the agent waits for it.
// One open proposal per file, in memory.

const open = new Map<string, Proposal>()

const results = new Map<string, PickResult>()

const waiters = new Map<string, ((r: PickResult) => void)[]>()

const LETTERS = ['A', 'B', 'C', 'D']

export function proposalFor(fileId: string): Proposal | null {
  return open.get(fileId) ?? null
}

export function propose(
  f: OpenFile,
  question: string,
  options: Omit<ProposalOption, 'letter'>[],
): Proposal {
  const prev = open.get(f.doc.id)

  if (prev) settle(f, prev, { picked: null, note: 'Replaced by a newer proposal.', removed: [] })

  const p: Proposal = {
    id: randomBytes(4).toString('hex'),
    question,
    options: options.map((o, i) => ({ ...o, letter: LETTERS[i] })),
  }

  open.set(f.doc.id, p)
  f.finishWorking(p.options.map((o) => o.nodeId))
  f.broadcast({ t: 'proposal', proposal: p })

  return p
}

/** The user's answer: keep the picked artboard where the first option was, remove the others (one undo step). */
export function pick(f: OpenFile, proposalId: string, nodeId: string | null, note?: string) {
  const p = open.get(f.doc.id)

  if (!p || p.id !== proposalId) throw new Error('That proposal is no longer open.')
  const picked = nodeId ? p.options.find((o) => o.nodeId === nodeId) : null

  if (nodeId && !picked) throw new Error('Not one of the options.')

  const removed = picked
    ? p.options.filter((o) => o !== picked && f.doc.nodes[o.nodeId]).map((o) => o.nodeId)
    : []

  if (removed.length) {
    const first = f.doc.nodes[p.options[0].nodeId]
    const ops: Op[] = [{ t: 'delete', ids: removed }]

    if (picked !== p.options[0] && first)
      ops.push({
        t: 'styles',
        id: picked!.nodeId,
        set: { left: first.styles.left ?? null, top: first.styles.top ?? null },
      })
    f.transact(ops, 'user', `pick ${picked!.letter}`)
  }

  settle(f, p, { picked: picked ?? null, note: note?.trim() || undefined, removed })
}

function settle(f: OpenFile, p: Proposal, r: Omit<PickResult, 'proposalId' | 'question'>) {
  open.delete(f.doc.id)
  const result: PickResult = { proposalId: p.id, question: p.question, ...r }
  results.set(p.id, result)

  for (const w of waiters.get(p.id) ?? []) w(result)
  waiters.delete(p.id)
  f.broadcast({ t: 'proposal', proposal: null })
}

/** Resolves with the answer, or null if the user hasn't picked within the timeout. */
export function waitForPick(proposalId: string, timeoutMs: number): Promise<PickResult | null> {
  const done = results.get(proposalId)

  if (done) return Promise.resolve(done)

  if (![...open.values()].some((p) => p.id === proposalId))
    return Promise.reject(new Error(`No proposal "${proposalId}".`))

  return new Promise((resolve) => {
    const w = (r: PickResult) => {
      clearTimeout(timer)
      resolve(r)
    }

    const timer = setTimeout(() => {
      waiters.set(
        proposalId,
        (waiters.get(proposalId) ?? []).filter((x) => x !== w),
      )
      resolve(null)
    }, timeoutMs)

    waiters.set(proposalId, [...(waiters.get(proposalId) ?? []), w])
  })
}
