/**
 * Stands in for `electron` when main-process code is bundled and run under
 * plain Node.
 *
 * `src/main/**` imports `app` only to resolve paths, so a check that exercises
 * the real production module needs nothing more than this. Point `DWT_USERDATA`
 * at a throwaway directory - never at the real profile, which holds the user's
 * history. See AGENTS.md.
 */
export const app = {
  isPackaged: false,
  getPath(name: string): string {
    if (name === 'userData') {
      const dir = process.env.DWT_USERDATA
      if (!dir) throw new Error('set DWT_USERDATA to a throwaway directory')
      return dir
    }
    if (name === 'home') return process.env.USERPROFILE ?? ''
    if (name === 'documents') return (process.env.USERPROFILE ?? '') + '/Documents'
    throw new Error('unexpected getPath: ' + name)
  }
}

export const shell = {
  async trashItem(): Promise<void> {},
  async openPath(): Promise<string> {
    return ''
  }
}
