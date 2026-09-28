import { useEffect } from 'react'
import { store, useStore } from '../store'
import { zoomToFit } from './actions'

// An agent's options for one decision (propose_options): framed on the canvas,
// labelled A to D, and picked here with a key or a click, with an optional note.

export function PickBar() {
  const proposal = useStore((s) => s.proposal)
  const note = useStore((s) => s.pickNote)
  useEffect(() => {
    if (proposal) requestAnimationFrame(() => zoomToFit(proposal.options.map((o) => o.nodeId)))
  }, [proposal?.id])

  if (!proposal) return null

  return (
    <div className="pw-pick" role="dialog" aria-label="Pick an option">
      <span className="pw-pick-question" title={proposal.question}>
        {proposal.question}
      </span>
      <span className="pw-pick-sep" />
      {proposal.options.map((o) => (
        <button
          key={o.nodeId}
          className="pw-pick-option"
          title={o.note ? `${o.note} (${o.letter})` : o.letter}
          onPointerEnter={() => store.setHover(o.nodeId)}
          onPointerLeave={() => store.setHover(null)}
          onClick={() => store.pick(o.nodeId)}
        >
          <kbd>{o.letter}</kbd>
          {o.label}
        </button>
      ))}
      <span className="pw-pick-sep" />
      <input
        className="pw-pick-note"
        placeholder="Note for the agent"
        value={note}
        spellCheck={false}
        onChange={(e) => store.setPickNote(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()

          if (e.key === 'Escape' || e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      <button
        className="pw-pick-none"
        title="None of these; the note says why"
        onClick={() => store.pick(null)}
      >
        None
      </button>
    </div>
  )
}
