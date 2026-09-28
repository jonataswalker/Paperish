import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { CommentThread } from '../../shared/types'
import { shallow, store, useStore } from '../store'
import { reveal } from './actions'
import { Icon } from './icons'
import { useWorldRects } from './measure'
import { timeAgo } from './Topbar'

// Comment mode (C): pins on the canvas and a panel with the threads. People
// write here; agents read, reply and resolve through MCP.

const isAgent = (authorId: string) => authorId === 'agent' || authorId.startsWith('agent:')

function visible(t: CommentThread, showResolved: boolean) {
  return showResolved || t.status === 'open'
}

/** Pins for the current page, drawn in the overlay's pan layer. */
export function CommentPins() {
  const on = useStore((s) => s.tool === 'comment')
  const pageId = useStore((s) => s.pageId)
  const active = useStore((s) => s.activeThread)
  const draft = useStore((s) => s.commentDraft)

  const threads = useStore(
    (s) => (s.doc?.comments ?? []).filter((t) => t.pageId === pageId && visible(t, s.showResolved)),
    shallow,
  )

  const anchors = [...threads.map((t) => t.nodeId), draft?.nodeId].filter(
    (id): id is string => !!id,
  )

  const rects = useWorldRects(on ? [...new Set(anchors)] : [])

  if (!on) return null

  const at = (p: { nodeId: string | null; x?: number; y?: number }) => {
    const base = p.nodeId ? rects[p.nodeId] : { x: 0, y: 0 }

    // SAFETY: custom properties for the pin's world position; React passes --* through to CSS.
    return base
      ? ({ '--x': base.x + (p.x ?? 0), '--y': base.y + (p.y ?? 0) } as CSSProperties)
      : null
  }

  return (
    <>
      {threads.map((t) => {
        const style = at(t)
        const first = t.messages[0]

        if (!style || !first) return null

        return (
          <button
            key={t.id}
            className={`pw-pin ${isAgent(first.authorId) ? 'agent' : ''} ${t.status} ${active === t.id ? 'active' : ''}`}
            style={style}
            title={`${first.authorName}: ${first.text}`}
            onPointerDown={(e) => {
              e.stopPropagation()
              store.openThread(t.id)
            }}
          >
            {initial(first.authorName)}
          </button>
        )
      })}
      {draft && at(draft) && <span className="pw-pin draft" style={at(draft)!} />}
    </>
  )
}

export function CommentsPanel() {
  const on = useStore((s) => s.tool === 'comment')
  const comments = useStore((s) => s.doc?.comments ?? [], shallow)
  const pages = useStore((s) => s.doc?.pages ?? [], shallow)
  const pageId = useStore((s) => s.pageId)
  const active = useStore((s) => s.activeThread)
  const draft = useStore((s) => s.commentDraft)
  const showResolved = useStore((s) => s.showResolved)
  const readOnly = useStore((s) => s.view?.kind === 'branch')

  if (!on) return null
  const open = comments.filter((t) => t.status === 'open').length
  const resolved = comments.length - open

  const shown = comments
    .filter((t) => visible(t, showResolved) || t.id === active)
    .toSorted(
      (a, b) =>
        Number(b.pageId === pageId) - Number(a.pageId === pageId) ||
        b.createdAt.localeCompare(a.createdAt),
    )

  const pageName = (id: string) => pages.find((p) => p.id === id)?.name ?? 'Deleted page'

  return (
    <aside className="pw-inspect pw-comments" aria-label="Comments">
      <button
        className="pw-icon-btn pw-inspect-close"
        title="Close (Esc)"
        onClick={() => store.setTool('move')}
      >
        <Icon.Close size={13} />
      </button>
      <section className="pw-section">
        <header className="pw-section-head">
          <span>
            Comments <span className="pw-count">{open || ''}</span>
          </span>
        </header>
        {draft && !readOnly && (
          <Composer
            key="draft"
            placeholder="Add a comment"
            submitLabel="Comment"
            onSubmit={(text) => store.postComment(text)}
            onCancel={() => store.startComment(null)}
          />
        )}
        {!shown.length && !draft ? (
          <p className="pw-empty">
            {readOnly ? 'No comments on this version.' : 'Click a layer to leave a comment.'}
          </p>
        ) : (
          <div className="pw-thread-list">
            {shown.map((t) =>
              t.id === active ? (
                <Thread key={t.id} thread={t} readOnly={readOnly} />
              ) : (
                <ThreadRow
                  key={t.id}
                  thread={t}
                  where={t.pageId === pageId ? null : pageName(t.pageId)}
                />
              ),
            )}
          </div>
        )}
      </section>
      {resolved > 0 && (
        <section className="pw-section pw-comments-foot">
          <label>
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => store.setShowResolved(e.target.checked)}
            />
            Show resolved ({resolved})
          </label>
        </section>
      )}
    </aside>
  )
}

function ThreadRow({ thread: t, where }: { thread: CommentThread; where: string | null }) {
  const first = t.messages[0]
  const replies = t.messages.length - 1

  if (!first) return null

  return (
    <div
      className={`pw-thread-row ${t.status}`}
      onClick={() => {
        store.openThread(t.id)

        if (t.nodeId) requestAnimationFrame(() => reveal([t.nodeId!]))
      }}
    >
      <Avatar authorId={first.authorId} name={first.authorName} />
      <span className="pw-thread-text">
        <span className="pw-thread-meta">
          <span className="pw-thread-author">{first.authorName}</span>
          <span>{timeAgo(first.createdAt)}</span>
        </span>
        <span className="pw-thread-body">{first.text}</span>
        {(replies > 0 || where) && (
          <span className="pw-thread-meta">
            {replies > 0 && <span>{replies === 1 ? '1 reply' : `${replies} replies`}</span>}
            {where && <span>{where}</span>}
          </span>
        )}
      </span>
    </div>
  )
}

function Thread({ thread: t, readOnly }: { thread: CommentThread; readOnly: boolean }) {
  const layer = useStore((s) => (t.nodeId ? s.doc?.nodes[t.nodeId]?.name : undefined))

  return (
    <div className={`pw-thread ${t.status}`}>
      <div className="pw-thread-head">
        <span className="pw-thread-layer">{t.nodeId ? (layer ?? 'Deleted layer') : 'Canvas'}</span>
        {!readOnly && (
          <>
            <button
              className="pw-icon-btn"
              title={t.status === 'open' ? 'Resolve' : 'Reopen'}
              onClick={() =>
                store.send({
                  t: 'comment:status',
                  threadId: t.id,
                  status: t.status === 'open' ? 'resolved' : 'open',
                })
              }
            >
              {t.status === 'open' ? <Icon.Check size={13} /> : <Icon.Undo size={13} />}
            </button>
            <button
              className="pw-icon-btn"
              title="Delete thread"
              onClick={() => store.send({ t: 'comment:delete', threadId: t.id })}
            >
              <Icon.Trash size={13} />
            </button>
          </>
        )}
        <button className="pw-icon-btn" title="Close" onClick={() => store.openThread(null)}>
          <Icon.Close size={12} />
        </button>
      </div>
      {t.messages.map((m) => (
        <div key={m.id} className="pw-message">
          <Avatar authorId={m.authorId} name={m.authorName} />
          <span className="pw-thread-text">
            <span className="pw-thread-meta">
              <span className="pw-thread-author">{m.authorName}</span>
              <span>{timeAgo(m.createdAt)}</span>
            </span>
            <span className="pw-message-body">{m.text}</span>
          </span>
        </div>
      ))}
      {!readOnly && (
        <Composer
          key={t.id}
          placeholder="Reply"
          submitLabel="Reply"
          onSubmit={(text) => store.send({ t: 'comment:reply', threadId: t.id, text })}
        />
      )}
    </div>
  )
}

function Composer({
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  placeholder: string
  submitLabel: string
  onSubmit: (text: string) => void
  onCancel?: () => void
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const raf = requestAnimationFrame(() => ref.current?.focus())

    return () => cancelAnimationFrame(raf)
  }, [])

  const submit = () => {
    if (!text.trim()) return
    onSubmit(text)
    setText('')
  }

  return (
    <div className="pw-composer">
      <textarea
        ref={ref}
        rows={2}
        value={text}
        placeholder={placeholder}
        spellCheck
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()

          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            onCancel?.()
            e.currentTarget.blur()
          }
        }}
      />
      <div className="pw-composer-actions">
        {onCancel && (
          <button className="pw-btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="pw-btn primary" disabled={!text.trim()} onClick={submit}>
          {submitLabel}
        </button>
      </div>
    </div>
  )
}

function Avatar({ authorId, name }: { authorId: string; name: string }) {
  return <span className={`pw-avatar ${isAgent(authorId) ? 'agent' : ''}`}>{initial(name)}</span>
}

function initial(name: string) {
  return (name.trim()[0] ?? '?').toUpperCase()
}

/** Status bar: open threads in the file; toggles comment mode. */
export function CommentsStatus() {
  const open = useStore((s) => s.doc?.comments.filter((t) => t.status === 'open').length ?? 0)
  const on = useStore((s) => s.tool === 'comment')

  return (
    <button
      className={`pw-status-item ${on ? 'on' : ''}`}
      title="Comments (C)"
      onClick={() => store.setTool(on ? 'move' : 'comment')}
    >
      <Icon.Comment size={13} />
      {open > 0 && open}
    </button>
  )
}
