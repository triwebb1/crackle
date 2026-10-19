/**
 * The only two build-mode flags Crackle reads, declared by hand rather than by pulling in Vite's
 * client types, because nothing else in `src` needs them and the project takes no new dependencies.
 *
 * `MODE` is what separates a dev server (`development`) from a production build (`production`) and
 * from the test runner (`test`), which is the distinction the rich demo seed is gated on.
 */
interface ImportMetaEnv {
  readonly DEV: boolean
  readonly PROD: boolean
  readonly MODE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
