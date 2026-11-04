/* ------------------------------------------------------------------ */
/* i18n                                                               */
/* ------------------------------------------------------------------ */

/**
 * Localization for the Notes GUI, following the Opencode locale but
 * supporting only two bundles — `pt-br` and `en-us` — with everything
 * else (unknown/missing locales) falling back to `en-us`.
 *
 * `en-us` is the default table: keys missing from the `pt-br` table are
 * served from it, so an incomplete translation can never lose a string.
 */

import { createMemo } from "solid-js"
import type { Accessor } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"

export type SupportedLocale = "en-us" | "pt-br"

/**
 * Maps the raw Opencode locale tag (IETF, e.g. `"pt-BR"`, `"en-US"`, `"en"`)
 * to one of the two supported bundles. Only tags that clearly indicate
 * Portuguese resolve to `pt-br`; everything else falls back to `en-us`.
 */
export function supportedLocale(raw?: string): SupportedLocale {
  const tag = (raw ?? "").trim().toLowerCase().replace(/[-_]/g, "")
  return tag.startsWith("pt") ? "pt-br" : "en-us"
}

const EN = {
  notesTitle: "Notes",
  notesCount: "{0} notes",
  newNote: "New note",
  searchLabel: "Search notes",
  searchPlaceholder: "Search memory…",
  filterPinned: "Pinned",
  filterRetracted: "Retracted",
  filterProject: "Project",
  scopeAll: "Global",
  scopeMachine: "Machine",
  scopeProject: "Project",
  "filter.scope.label": "Scope",
  "filter.scope.placeholder": "All scopes",
  "filter.category.label": "Category",
  "filter.category.placeholder": "All categories",
  "filter.tag.label": "Tag",
  "filter.tag.placeholder": "All tags",
  "filter.clear": "Clear",
  "filter.search": "Filter…",
  "filter.none": "No matches",
  "category.problem": "Problem",
  "category.decision": "Decision",
  "category.config": "Config",
  "category.snippet": "Snippet",
  "category.architecture": "Architecture",
  "category.user": "User",
  "category.general": "General",
  "form.title.label": "Title",
  "form.content.label": "Content",
  "form.content.placeholder": "Record here what needs to be remembered…",
  "form.author.label": "Author",
  "form.author.placeholder": "auto — who recorded",
  "form.category.label": "Category",
  "form.scope.label": "Scope",
  "form.project.label": "Project",
  "form.project.placeholder": "Choose one or more projects",
  "form.tags.label": "Tags",
  "form.tags.placeholder": "space-separated keywords",
  "form.cancel": "Cancel",
  "form.add": "Add note",
  "form.save": "Save changes",
  "form.required": "Title and content are required.",
  "form.saveError": "Save failed",
  "badge.pinned": "pinned",
  "badge.verified": "verified",
  "badge.retracted": "retracted",
  "badge.disputed": "disputed",
  "actions.edit": "Edit",
  "actions.confirm": "Confirm",
  "actions.dispute": "Dispute",
  "actions.retract": "Retract",
  "actions.pin": "Pin",
  "actions.unpin": "Unpin",
  "actions.remove": "Delete",
  "actions.attachTooltip": "Add to context",
  "actions.attach": "Add note #{0} to context",
  "revisions.label": "Revisions",
  "revisions.empty": "No previous versions.",
  "revisions.head": "Revision #{0} · {1} · in effect since {2}",
  "page.previous": "Previous",
  "page.next": "Next",
  "page.label": "Page {0} of {1}",

  "empty.search": 'No notes match "{0}".',
  "empty.retracted": "No retracted notes.",
  "empty.project": "No notes from this project.",
  "empty.none": "No notes yet.",
  "empty.hint.search": "Adjust the search or the filters.",
  "empty.hint.retracted": 'Turn off the "Retracted" filter to see the rest.',
  "empty.hint.project": "This project has no notes yet.",
  "empty.hint.none": 'Record the first one with "New note".',
  "loading": "Loading…",
  "toast.confirm": "Note confirmed",
  "toast.dispute": "Note disputed",
  "toast.retract": "Note retracted",
  "toast.pin": "Note pinned",
  "toast.unpin": "Note unpinned",
  "toast.remove": "Note removed",
  "toast.restore": "Revision restored",
  "toast.actionError": "Action failed",
  "toast.noSession": "No session open",
  "toast.noSessionHint": "Open a session to add notes to context.",
  "toast.contextUnavailable": "Context unavailable right now",
  "toast.contextUnavailableHint": "This session's composer doesn't accept attachments at the moment.",
  "toast.attach": "Note #{0} added to context",
  "prompt.dispute.title": "Dispute note",
  "prompt.dispute.desc": "Describe why the note seems incorrect.",
  "prompt.dispute.placeholder": "e.g.: outdated, contradicts note #123",
  "prompt.dispute.submit": "Dispute",
  "prompt.retract.title": "Retract note",
  "prompt.retract.desc": "The note becomes disregarded; it can be restored later.",
  "prompt.retract.placeholder": "reason (optional)",
  "prompt.retract.submit": "Retract",
  "prompt.delete.title": "Delete note",
  "prompt.delete.desc": "Permanently delete note #{0} and all its versions. This cannot be undone.",
  "prompt.delete.confirm": "Delete",
  "prompt.restore.title": "Restore revision",
  "prompt.restore.desc": "The note will be restored to revision #{0}. The current version becomes a previous revision.",
  "prompt.restore.confirm": "Restore",
  "form.overlay.add": "New note",
  "form.overlay.edit": "Edit note",
} as const

const PT: Record<keyof typeof EN, string> = {
  notesTitle: "Notas",
  notesCount: "{0} notas",
  newNote: "Nova nota",
  searchLabel: "Buscar notas",
  searchPlaceholder: "Buscar na memória…",
  filterPinned: "Fixadas",
  filterRetracted: "Retiradas",
  filterProject: "Projeto",
  scopeAll: "Global",
  scopeMachine: "Máquina",
  scopeProject: "Projeto",
  "filter.scope.label": "Escopo",
  "filter.scope.placeholder": "Todos os escopos",
  "filter.category.label": "Categoria",
  "filter.category.placeholder": "Todas as categorias",
  "filter.tag.label": "Tag",
  "filter.tag.placeholder": "Todas as tags",
  "filter.clear": "Limpar",
  "filter.search": "Filtrar…",
  "filter.none": "Nada",
  "category.problem": "Problema",
  "category.decision": "Decisão",
  "category.config": "Configuração",
  "category.snippet": "Trecho",
  "category.architecture": "Arquitetura",
  "category.user": "Usuário",
  "category.general": "Geral",
  "form.title.label": "Título",
  "form.content.label": "Conteúdo",
  "form.content.placeholder": "Registre aqui o que precisa lembrar…",
  "form.author.label": "Autor",
  "form.author.placeholder": "auto — quem registrou",
  "form.category.label": "Categoria",
  "form.scope.label": "Escopo",
  "form.project.label": "Projeto",
  "form.project.placeholder": "Escolha um ou mais projetos",
  "form.tags.label": "Tags",
  "form.tags.placeholder": "palavras-chave separadas por espaço",
  "form.cancel": "Cancelar",
  "form.add": "Adicionar nota",
  "form.save": "Salvar alterações",
  "form.required": "Título e conteúdo são obrigatórios.",
  "form.saveError": "Falha ao salvar",
  "badge.pinned": "fixada",
  "badge.verified": "verificada",
  "badge.retracted": "retirada",
  "badge.disputed": "questionada",
  "actions.edit": "Editar",
  "actions.confirm": "Confirmar",
  "actions.dispute": "Questionar",
  "actions.retract": "Retirar",
  "actions.pin": "Fixar",
  "actions.unpin": "Desfixar",
  "actions.remove": "Excluir",
  "actions.attachTooltip": "Adicionar ao contexto",
  "actions.attach": "Adicionar nota #{0} ao contexto",
  "revisions.label": "Revisões",
  "revisions.empty": "Sem versões anteriores.",
  "revisions.head": "Revisão #{0} · {1} · válida desde {2}",
  "page.previous": "Anterior",
  "page.next": "Próxima",
  "page.label": "Página {0} de {1}",
  "empty.search": 'Nenhuma nota corresponde a "{0}".',
  "empty.retracted": "Nenhuma nota retirada.",
  "empty.project": "Nenhuma nota deste projeto.",
  "empty.none": "Nenhuma nota ainda.",
  "empty.hint.search": "Ajuste a busca ou os filtros.",
  "empty.hint.retracted": 'Desative o filtro "Retiradas" para ver as demais.',
  "empty.hint.project": "Este projeto ainda não tem notas.",
  "empty.hint.none": 'Registre a primeira com "Nova nota".',
  "loading": "Carregando…",
  "toast.confirm": "Nota confirmada",
  "toast.dispute": "Nota questionada",
  "toast.retract": "Nota retirada",
  "toast.pin": "Nota fixada",
  "toast.unpin": "Nota desfixada",
  "toast.remove": "Nota excluída",
  "toast.restore": "Revisão restaurada",
  "toast.actionError": "Ação falhou",
  "toast.noSession": "Nenhuma sessão aberta",
  "toast.noSessionHint": "Abra uma sessão para adicionar notas ao contexto.",
  "toast.contextUnavailable": "Contexto indisponível agora",
  "toast.contextUnavailableHint": "O compositor desta sessão não aceita anexos neste momento.",
  "toast.attach": "Nota #{0} adicionada ao contexto",
  "prompt.dispute.title": "Questionar nota",
  "prompt.dispute.desc": "Descreva por que a nota parece incorreta.",
  "prompt.dispute.placeholder": "ex.: desatualizada, contradiz a nota #123",
  "prompt.dispute.submit": "Questionar",
  "prompt.retract.title": "Retirar nota",
  "prompt.retract.desc": "A nota passa a ser desconsiderada; pode ser restaurada depois.",
  "prompt.retract.placeholder": "motivo (opcional)",
  "prompt.retract.submit": "Retirar",
  "prompt.delete.title": "Excluir nota",
  "prompt.delete.desc": "Excluir permanentemente a nota #{0} e todas as suas versões. Não há como recuperar.",
  "prompt.delete.confirm": "Excluir",
  "prompt.restore.title": "Restaurar revisão",
  "prompt.restore.desc": "A nota será restaurada para a revisão #{0}. A versão atual passa a ser uma revisão anterior.",
  "prompt.restore.confirm": "Restaurar",
  "form.overlay.add": "Nova nota",
  "form.overlay.edit": "Editar nota",
}

const tables: Record<SupportedLocale, Record<string, string>> = {
  "en-us": EN,
  "pt-br": { ...EN, ...PT },
}

/** Reactive locale: `pt-br` when Opencode is Portuguese, `en-us` otherwise. */
export function useLocale(): Accessor<SupportedLocale> {
  const ctx = usePlugin()
  return createMemo(() => supportedLocale(ctx.locale.locale()))
}

/**
 * Returns a `t` function that looks up a key in the active bundle and
 * interpolates positional `{0}`, `{1}`… placeholders from the arguments.
 * Unknown keys fall back to the first argument (used by callers that pass
 * a raw display value, e.g. `t("category.${v}", v)`), and then to the key
 * itself — the UI should never render an empty string.
 */
export function useT(): (key: string, ...args: unknown[]) => string {
  const locale = useLocale()
  return (key: string, ...args: unknown[]): string => {
    const table = tables[locale()]
    const value = table[key] ?? (typeof args[0] === "string" ? args[0] : key)
    return value.replace(/\{(\d+)\}/g, (_, i: string) =>
      String(args[Number(i)] ?? "")
    )
  }
}

/**
 * Display label for a note's scope: the type names are localized; the project
 * data is never translated. Returns `""` for the default `"all"` scope (no
 * chip). For project scope, one basename per project path is joined (a single
 * path shows just its basename; several paths show all of them).
 */
export function scopeChipLabel(
  t: (key: string, ...args: unknown[]) => string,
  scope: string | undefined,
  projects?: readonly string[] | undefined,
): string {
  if (!scope || scope === "all") return ""
  if (scope === "machine") return t("scopeMachine")
  if (scope === "project") {
    const paths = projects ?? []
    if (paths.length === 0) return t("scopeProject")
    return paths.map((p) => p.split("/").pop() ?? p).join(" · ")
  }
  return t("scopeProject")
}
