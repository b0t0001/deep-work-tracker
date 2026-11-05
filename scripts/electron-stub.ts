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

/**
 * What the stub was asked to trash or open, in call order.
 *
 * Recorded rather than ignored for two reasons: an empty function body is a
 * lint error, and a check that exercises retention should be able to assert
 * *which* files would have gone to the bin without any of them moving.
 */
export const trashed: string[] = []
export const opened: string[] = []

export const shell = {
  async trashItem(path: string): Promise<void> {
    trashed.push(path)
  },
  async openPath(path: string): Promise<string> {
    opened.push(path)
    return ''
  }
}
