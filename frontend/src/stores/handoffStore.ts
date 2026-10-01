import { createStore } from 'zustand/vanilla'
import type { HandoffRecord } from '@/types'
import { db, syncAll } from '@/hooks/usePersistentStore'

export interface HandoffState {
  records: HandoffRecord[]
  loaded: boolean
  hydrate: () => Promise<void>
}

export const handoffStore = createStore<HandoffState>((set) => ({
  records: [],
  loaded: false,
  hydrate: async () => {
    const records = await syncAll<HandoffRecord>(db.handoffs)
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    set({ records, loaded: true })
  }
}))
