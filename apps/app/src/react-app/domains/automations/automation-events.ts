export const automationsStateChangedEvent = "offlinegpt:automations-state-changed"

export function dispatchAutomationsStateChanged() {
  window.dispatchEvent(new CustomEvent(automationsStateChangedEvent))
}
