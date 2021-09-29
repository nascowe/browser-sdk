import { HookResetter } from './types'

export function hookSetter<T>(
  target: T,
  key: string | number | symbol,
  d: { set(this: T, value: unknown): void }
): HookResetter {
  const original = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, {
    set(this: T, value) {
      // put hooked setter into event loop to avoid of set latency
      setTimeout(() => {
        d.set.call(this, value)
      }, 0)
      if (original && original.set) {
        original.set.call(this, value)
      }
    },
  })
  return () => {
    Object.defineProperty(target, key, original || {})
  }
}

export function getWindowHeight(): number {
  if (visualViewport) {
    return visualViewport.height * visualViewport.scale
  }
  return (
    window.innerHeight ||
    (document.documentElement && document.documentElement.clientHeight) ||
    (document.body && document.body.clientHeight)
  )
}

export function getWindowWidth(): number {
  if (visualViewport) {
    return visualViewport.width * visualViewport.scale
  }
  return (
    window.innerWidth ||
    (document.documentElement && document.documentElement.clientWidth) ||
    (document.body && document.body.clientWidth)
  )
}

export function isTouchEvent(event: MouseEvent | TouchEvent): event is TouchEvent {
  return Boolean((event as TouchEvent).changedTouches)
}

export function forEach<List extends { [index: number]: any }>(
  list: List,
  callback: (value: List[number], index: number, parent: List) => void
) {
  Array.prototype.forEach.call(list, callback as any)
}
