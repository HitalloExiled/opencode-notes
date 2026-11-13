/**
 * The global notes surface: a titlebar pill with the total count and the
 * overlay it opens.
 *
 * The pill lives in the host's titlebar (two plugins can sit side by side
 * there); the overlay covers the window with the shared `NotesBody`, so the
 * panel and the global surface have one implementation. The count is module
 * state shared by the pill (registered in `setup`) and the overlay.
 *
 * The overlay is ours, not `ctx.ui.Dialog`: the host caps dialogs at 980×600,
 * while this one uses the window height minus 40px. Esc, outside click, focus
 * and scroll lock are handled here, following the panel editor's overlay.
 */

import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { Context } from "@opencode/plugin/gui"
import { NotesApi } from "./contract"
import { useT } from "./i18n"
import { NotesBody } from "./view"

const CSS = `
.notes-modal-scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  background: var(--v2-overlay-simple-overlay-scrim);
}
.notes-modal {
  display: flex;
  flex-direction: column;
  width: min(900px, calc(100% - 20px));
  height: calc(100% - 40px);
  min-height: 0;
  box-sizing: border-box;
  overflow: hidden;
  border-radius: 8px;
  background: var(--v2-background-bg-layer-01);
  box-shadow: var(--v2-elevation-raised);
  outline: none;
}
.notes-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--v2-border-border-muted);
}
.notes-modal-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--v2-text-text-base);
}
.notes-modal-body { flex: 1; min-height: 0; }
.notes-modal-scrim.is-closed { display: none; }
`

const [count, setCount] = createSignal(0)
const [opened, setOpened] = createSignal(false)

/** Total notes, for the titlebar pill. */
export const noteCount = (): number => count()
export const openNotesOverlay = (): void => {
  setOpened(true)
}
const close = (): void => {
  setOpened(false)
}

/**
 * Starts the note count (mount, window focus, every minute). Call once from
 * `setup`; the returned cleanup stops the timer and the listener.
 */
export function startNotesCount(ctx: Context): () => void {
  const refresh = () => {
    const api = ctx.main(NotesApi)
    void api
      .count()
      .then((total) => setCount(total))
      .catch(() => undefined)
  }
  refresh()
  const timer = setInterval(refresh, 60_000)
  const onFocus = () => refresh()
  window.addEventListener("focus", onFocus)
  return () => {
    clearInterval(timer)
    window.removeEventListener("focus", onFocus)
  }
}

/** The overlay shell: scrim, header, and the shared notes body. */
function NotesModal(props: { onClose: () => void }) {
  const ctx = usePlugin()
  const t = useT()
  let panel: HTMLDivElement | undefined
  let previous: Element | null = null

  onMount(() => {
    previous = document.activeElement
    const overflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    panel?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      props.onClose()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = overflow
      if (previous instanceof HTMLElement) previous.focus()
    })
  })

  // Keep Tab inside the overlay; the panel itself takes focus first.
  const trapTab = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || !panel) return
    const focusables = panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
    const first = focusables[0]
    if (!first) {
      event.preventDefault()
      return
    }
    const last = focusables[focusables.length - 1]!
    const current = document.activeElement
    if (event.shiftKey && (current === first || current === panel)) {
      event.preventDefault()
      last.focus()
      return
    }
    if (!event.shiftKey && current === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div class="notes-modal-scrim" onClick={() => props.onClose()}>
      <div
        ref={panel}
        class="notes-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("modal.title")}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div class="notes-modal-head">
          <h2 class="notes-modal-title">{t("modal.title")}</h2>
          <ctx.ui.IconButton icon="close" label={t("modal.close")} onClick={() => props.onClose()} />
        </div>
        <div class="notes-modal-body">
          <NotesBody visible={() => true} mode="modal" />
        </div>
      </div>
    </div>
  )
}

/**
 * Mounted by the plugin's `window.bottom` slot item; renders the overlay only
 * while open, so the slot adds no visible row when idle.
 */
export function NotesOverlay() {
  return (
    <Show when={opened()}>
      <style>{CSS}</style>
      <NotesModal onClose={close} />
    </Show>
  )
}
