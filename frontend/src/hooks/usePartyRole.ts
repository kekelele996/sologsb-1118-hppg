import { ref } from 'vue'
import type { PartyRole } from '@/types'

const STORAGE_KEY = 'gbtrenchlog.role'
const role = ref<PartyRole>((localStorage.getItem(STORAGE_KEY) as PartyRole) || 'field')

/** 当前站点角色（发掘现场 / 资料室），保存在浏览器本地，可随时切换演示两侧 */
export function usePartyRole() {
  function setRole(next: PartyRole): void {
    role.value = next
    localStorage.setItem(STORAGE_KEY, next)
  }

  function toggleRole(): void {
    setRole(role.value === 'field' ? 'archive' : 'field')
  }

  return { role, setRole, toggleRole }
}
