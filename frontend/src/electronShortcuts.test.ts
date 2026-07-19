import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({
  register: vi.fn<(accelerator: string, callback: () => void) => boolean>(),
  send: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    dock: { hide: vi.fn(), show: vi.fn() },
    getPath: vi.fn(() => 'C:\\Users\\test'),
  },
  globalShortcut: {
    register: electronMock.register,
  },
}))

describe('Electron recording shortcuts', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    electronMock.register.mockReturnValue(true)
  })

  it('registers an independent pause shortcut and sends its renderer event', async () => {
    const { registerAppShortcuts } = await import('../../electron/shortcuts')
    registerAppShortcuts({
      getMainWindow: () => ({
        isDestroyed: () => false,
        isVisible: () => true,
        hide: vi.fn(),
        show: vi.fn(),
        focus: vi.fn(),
        webContents: { send: electronMock.send },
      }) as never,
      isTrayReady: () => true,
    })

    const pauseRegistration = electronMock.register.mock.calls.find(
      ([accelerator]) => accelerator === 'CommandOrControl+Shift+P',
    )
    expect(pauseRegistration).toBeDefined()
    pauseRegistration?.[1]()
    expect(electronMock.send).toHaveBeenCalledWith('toggle-recording-pause')
  })

  it('falls back to CommandOrControl+Alt+P when the primary shortcut is occupied', async () => {
    electronMock.register.mockImplementation((accelerator) => accelerator !== 'CommandOrControl+Shift+P')
    const { registerAppShortcuts } = await import('../../electron/shortcuts')
    registerAppShortcuts({
      getMainWindow: () => null,
      isTrayReady: () => false,
    })

    expect(electronMock.register).toHaveBeenCalledWith(
      'CommandOrControl+Alt+P',
      expect.any(Function),
    )
  })
})
