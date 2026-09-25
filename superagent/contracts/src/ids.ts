import { randomBytes } from 'node:crypto'

/**
 * Sortable, collision-resistant id: `<prefix>_<base36 ms><6 hex>`.
 * @param prefix - record kind, e.g. `task`.
 * @returns a new id.
 */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
}

export const now = (): string => new Date().toISOString()
