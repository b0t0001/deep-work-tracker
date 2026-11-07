import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  // .claude/ holds other agents' git worktrees: their work in progress is not
  // this checkout's code, and linting it reported 57 problems that were not here.
  { ignores: ['**/node_modules', '**/dist', '**/out', '.claude/**'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      // `window.api as unknown as X` is banned, and this is the only thing
      // watching for the fault it causes.
      //
      // `preload/index.ts` exports `DeepWorkApi = typeof api` and
      // `index.d.ts` declares `window.api` as it, so the renderer gets every
      // channel's real shape and a mismatch between the two halves is a
      // compile error. Casting through `unknown` throws that away - and an
      // IPC boundary is the one surface where both sides may be written by
      // different sessions at the same time.
      //
      // On 2026-11-05 that cost an afternoon: the renderer declared
      // `set(layout: Layout)` while preload declared `set(json: string)`, the
      // save threw in the main process, the rejection was swallowed by
      // design, and the "Not saved" warning could not fire because it checked
      // that the functions existed rather than that they worked. Typecheck
      // was clean throughout.
      //
      // Nothing else can catch that class. `persists` and the IPC harness
      // both detect a handler that *throws*; neither can detect a bridge of
      // the wrong *shape*, because `contextBridge` freezes what it exposes -
      // the renderer cannot substitute a differently-shaped channel to find
      // out. See notes/implementer-contextbridge-cannot-be-faked.md.
      //
      // Use `Partial<DeepWorkApi>` when a channel may genuinely be absent:
      // that handles absence without hiding shape.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "TSAsExpression > TSAsExpression > MemberExpression[object.name='window'][property.name='api']",
          message:
            'Do not cast window.api through unknown - derive from DeepWorkApi, or use Partial<DeepWorkApi> if the channel may be absent. This cast is why a real IPC mismatch typechecked clean for three commits, and nothing else in the codebase watches for that fault.'
        }
      ]
    }
  },
  eslintConfigPrettier
)
