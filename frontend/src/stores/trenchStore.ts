import { createStore } from 'zustand/vanilla'
import type { Trench } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import type { PartyRole } from '@/types'

export interface TrenchState {
  trenches: Trench[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** role 为现场时自增 fieldRev（现场每改一次，修订号 +1）；资料室侧合并/定稿不自增 */
  save: (trench: Trench, role?: PartyRole) => Promise<void>
  remove: (id: string) => Promise<void>
  setBackfilled: (id: string, backfilled: boolean) => Promise<void>
}

export const trenchStore = createStore<TrenchState>((set, get) => ({
  trenches: [],
  loaded: false,
  hydrate: async () => {
    const trenches = await syncAll<Trench>(db.trenches)
    trenches.sort((a, b) => `${a.area}${a.code}`.localeCompare(`${b.area}${b.code}`, 'zh-Hans-CN'))
    set({ trenches, loaded: true })
  },
  save: async (trench, role = 'field') => {
    const previous = get().trenches.find((item) => item.id === trench.id)
    const fieldRev = role === 'field' ? Math.max(trench.fieldRev ?? 1, previous?.fieldRev ?? 0) + 1 : trench.fieldRev ?? 1
    await syncPut<Trench>(db.trenches, { ...trench, fieldRev })
    await get().hydrate()
  },
  remove: async (id) => {
    await syncDelete<Trench>(db.trenches, id)
    await get().hydrate()
  },
  setBackfilled: async (id, backfilled) => {
    const target = get().trenches.find((item) => item.id === id)
    if (!target) return
    await syncPut<Trench>(db.trenches, { ...target, backfilled })
    await get().hydrate()
  }
}))
