export const OPEN_FULL_TAB_MENU_ID = 'handoff-open-full-tab'
export const FULL_TAB_PATH = 'sidepanel.html?view=tab'
export const PANEL_DRAFT_KEY = 'panel-view-draft-v1'

export type PanelViewMessage =
  | { target: 'background'; type: 'panel.open-tab' }
  | { target: 'ui'; type: 'panel.prepare-tab' }

export function isFullTab(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('view') === 'tab'
}
