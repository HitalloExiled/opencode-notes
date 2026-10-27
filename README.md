# opencode-notes

Plugin de **memória de longa duração curada** para o [OpenCode](https://opencode.ai)
(V2). Expõe as operações do CLI global `notes` como tools tipadas no namespace
`notes` — decisões, problemas resolvidos, configurações e snippets, com ciclo de
confiança (`confirm`/`dispute`/`retract`) e histórico completo de versões.

O plugin é autocontido: nenhum import de fora do diretório (só
`@opencode/plugin` e `zod`, instalados pelo próprio `package.json`), e nenhum
dado é escrito dentro do repo — o banco vive em
`~/.local/share/opencode/memory/notes.db` (ou `$NOTES_DB`).

## Instalação

```bash
git clone git@github.com:HitalloExiled/opencode-notes.git
cd opencode-notes
npm install
mkdir -p ~/.config/opencode/plugins
ln -sfn "$PWD" ~/.config/opencode/plugins/notes
```

Reinicie o OpenCode (ou aguarde o hot-reload). O plugin precisa do CLI `notes`
disponível (o `opencode-tools` instala o symlink `~/.local/bin/notes` via
`setup.sh`); o wrapper resolve o binário por `$NOTES_BIN` > `~/.local/bin/notes`
> `PATH`.

> Pré-publicação: enquanto o plugin não está publicado, o fluxo acima é o
> caminho de instalação. O repo `opencode-tools` consome este projeto como
> **git submodule** em `plugins/notes` e faz o mesmo symlink via `setup.sh`
> (que também roda o `npm install` dentro dele).

## O que o plugin faz

1. **Registra fatos duráveis** (`add`) com categoria, tags, autor e scope
   por convenção (`Scope: global | project:<nome> | machine:<nome>` na
   primeira linha do conteúdo). Notas `#problem` são validadas: sem
   Sintoma/Causa/Solução não são salvas.
2. **Ciclo de confiança** — `confirm` re-verifica (a nota continua valendo),
   `dispute` marca como suspeita sem reescrever, `retract` esconde sem apagar;
   `history`/`restore` guardam e recuperam cada versão anterior de
   `update`/`restore`. Nada é deletado.
3. **Busca e inspeção** — `search` (FTS5 quando disponível, senão `LIKE`),
   `view` (nota completa, inclusive re-traídas), `doctor` (diagnóstico do
   subsistema).

### Nomes e permissões

- **Code Mode:** `tools.notes.add`, `tools.notes.search`, ... (10 tools; grupo
  `notes` no catálogo).
- **Sessões regulares:** nomes efetivos `notes_add`, `notes_search`, ... — os
  mesmos de antes do refactor de namespace, então as regras de permissão
  existentes (`resource: "notes_add"` etc. no `opencode.jsonc`) continuam
  valendo sem mudança.

Mecânica: `Plugin.define` + `ctx.tool.transform` com `editor.namespace({name:
"notes"})` (só rotula o grupo no catálogo) e, por tool,
`options: { namespace: "notes" }` (é isto que prefixa o nome qualificado no
Code Mode). Schemas de entrada em zod (o `input` do SDK aceita
StandardSchemaV1); cada tool retorna `{content, metadata}`.

### Segurança

- Execução do CLI por `spawn` com `argv` (sem shell): o conteúdo da nota nunca
  é interpretado — aspas, `;`, `$(...)`, emoji e novas linhas ficam literais.
- Nenhum comando destrutivo é exposto: `retract` só esconde (reversível),
  `restore` recupera versões.

## Desenvolvimento

```bash
npm install
npm run typecheck
```
